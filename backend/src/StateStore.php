<?php

declare(strict_types=1);

namespace TravelPlanner\Bff;

use PDO;

final class StateStore
{
    private PDO $pdo;

    public function __construct(string $path)
    {
        $directory = dirname($path);
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new \RuntimeException('Unable to create BFF state directory.');
        }
        $this->pdo = new PDO('sqlite:' . $path, options: [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        @chmod($path, 0600);
        $this->pdo->exec('PRAGMA journal_mode=WAL');
        $this->pdo->exec('PRAGMA busy_timeout=1000');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(bucket, window))');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS leases (lease_key TEXT NOT NULL PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS cache (cache_key TEXT NOT NULL PRIMARY KEY, content_type TEXT NOT NULL, body BLOB NOT NULL, expires_at INTEGER NOT NULL)');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS circuits (provider TEXT NOT NULL PRIMARY KEY, failures INTEGER NOT NULL, opened_until INTEGER NOT NULL)');
    }

    public function consumeRate(string $bucket, int $limit, int $now): bool
    {
        $window = intdiv($now, 60);
        return $this->transaction(function () use ($bucket, $limit, $window): bool {
            $statement = $this->pdo->prepare('SELECT count FROM rate_limits WHERE bucket = ? AND window = ?');
            $statement->execute([$bucket, $window]);
            $row = $statement->fetch();
            $count = is_array($row) ? (int) $row['count'] : 0;
            if ($count >= $limit) return false;
            $upsert = $this->pdo->prepare('INSERT INTO rate_limits(bucket, window, count) VALUES(?, ?, 1) ON CONFLICT(bucket, window) DO UPDATE SET count=count+1');
            $upsert->execute([$bucket, $window]);
            return true;
        });
    }

    public function acquireLease(string $key, int $limit, int $now, int $leaseSeconds): bool
    {
        return $this->transaction(function () use ($key, $limit, $now, $leaseSeconds): bool {
            $statement = $this->pdo->prepare('SELECT count, expires_at FROM leases WHERE lease_key = ?');
            $statement->execute([$key]);
            $row = $statement->fetch();
            $count = is_array($row) && (int) $row['expires_at'] > $now ? (int) $row['count'] : 0;
            if ($count >= $limit) return false;
            $upsert = $this->pdo->prepare('INSERT INTO leases(lease_key, count, expires_at) VALUES(?, ?, ?) ON CONFLICT(lease_key) DO UPDATE SET count=?, expires_at=?');
            $upsert->execute([$key, $count + 1, $now + $leaseSeconds, $count + 1, $now + $leaseSeconds]);
            return true;
        });
    }

    public function releaseLease(string $key): void
    {
        $this->transaction(function () use ($key): void {
            $statement = $this->pdo->prepare('UPDATE leases SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END WHERE lease_key = ?');
            $statement->execute([$key]);
        });
    }

    /** @return array{content_type: string, body: string}|null */
    public function cacheGet(string $key, int $now): ?array
    {
        $statement = $this->pdo->prepare('SELECT content_type, body FROM cache WHERE cache_key = ? AND expires_at > ?');
        $statement->execute([$key, $now]);
        $row = $statement->fetch();
        return is_array($row) ? ['content_type' => (string) $row['content_type'], 'body' => (string) $row['body']] : null;
    }

    public function cachePut(string $key, string $contentType, string $body, int $expiresAt): void
    {
        $statement = $this->pdo->prepare('INSERT INTO cache(cache_key, content_type, body, expires_at) VALUES(?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET content_type=?, body=?, expires_at=?');
        $statement->execute([$key, $contentType, $body, $expiresAt, $contentType, $body, $expiresAt]);
    }

    public function assertCircuitClosed(string $provider, int $now): void
    {
        $statement = $this->pdo->prepare('SELECT opened_until FROM circuits WHERE provider = ?');
        $statement->execute([$provider]);
        $row = $statement->fetch();
        if (is_array($row) && (int) $row['opened_until'] > $now) {
            throw new ApiException(503, 'CIRCUIT_OPEN', 'Map provider is temporarily unavailable.');
        }
    }

    public function providerSucceeded(string $provider): void
    {
        $statement = $this->pdo->prepare('DELETE FROM circuits WHERE provider = ?');
        $statement->execute([$provider]);
    }

    public function providerFailed(string $provider, int $threshold, int $openedUntil): void
    {
        $this->transaction(function () use ($provider, $threshold, $openedUntil): void {
            $statement = $this->pdo->prepare('SELECT failures FROM circuits WHERE provider = ?');
            $statement->execute([$provider]);
            $row = $statement->fetch();
            $failures = (is_array($row) ? (int) $row['failures'] : 0) + 1;
            $open = $failures >= $threshold ? $openedUntil : 0;
            $upsert = $this->pdo->prepare('INSERT INTO circuits(provider, failures, opened_until) VALUES(?, ?, ?) ON CONFLICT(provider) DO UPDATE SET failures=?, opened_until=?');
            $upsert->execute([$provider, $failures, $open, $failures, $open]);
        });
    }

    /** @template T @param callable():T $operation @return T */
    private function transaction(callable $operation): mixed
    {
        $this->pdo->exec('BEGIN IMMEDIATE');
        try {
            $result = $operation();
            $this->pdo->commit();
            return $result;
        } catch (\Throwable $error) {
            if ($this->pdo->inTransaction()) $this->pdo->rollBack();
            throw $error;
        }
    }
}
