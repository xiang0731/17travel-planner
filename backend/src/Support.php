<?php

declare(strict_types=1);

namespace TravelPlanner\Bff;

use InvalidArgumentException;

interface Clock
{
    public function now(): int;

    public function nowFloat(): float;
}

final class SystemClock implements Clock
{
    public function now(): int
    {
        return time();
    }

    public function nowFloat(): float
    {
        return microtime(true);
    }
}

final class Config
{
    /** @var array<string, mixed> */
    private array $values;

    /** @param array<string, mixed> $overrides */
    public function __construct(array $overrides = [])
    {
        $defaults = [
            'environment' => 'test',
            'allowed_origins' => ['https://travel.example.test'],
            'require_origin_for_anonymous' => true,
            'session_secret' => str_repeat('t', 64),
            'session_cookie' => '__Host-travelplanner_session',
            'session_ttl_seconds' => 3600,
            'bearer_tokens' => [],
            'db_path' => sys_get_temp_dir() . '/travelplanner-bff.sqlite',
            'user_rate_per_minute' => 120,
            'anonymous_rate_per_minute' => 30,
            'global_rate_per_minute' => 1200,
            'upstream_connect_timeout_ms' => 800,
            'upstream_timeout_ms' => 4000,
            'upstream_max_response_bytes' => 5_242_880,
            'provider_concurrency' => 8,
            'concurrency_lease_seconds' => 10,
            'cache_ttl_places' => 300,
            'cache_ttl_routes' => 120,
            'cache_ttl_matrix' => 120,
            'cache_ttl_static_maps' => 600,
            'circuit_failure_threshold' => 5,
            'circuit_reset_seconds' => 30,
            'max_request_bytes' => 65_536,
            'provider_keys' => [
                'google' => '',
                'gaode' => '',
                'tianditu' => '',
                'azure' => '',
            ],
            'enabled_providers' => ['google', 'gaode', 'tianditu'],
            'credential_version' => 'v1',
        ];

        $this->values = array_replace_recursive($defaults, $overrides);
    }

    public static function fromEnvironment(): self
    {
        $environment = self::env('APP_ENV', 'production');
        $origins = self::csv(self::env('BFF_ALLOWED_ORIGINS', ''));
        $secret = self::env('BFF_SESSION_HMAC_SECRET', '');
        $tokens = self::decodeBearerTokens(self::env('BFF_BEARER_TOKENS_JSON', '[]'));
        $enabledProviders = self::csv(self::env('BFF_ENABLED_PROVIDERS', 'google,gaode,tianditu'));
        $providerKeys = [
            'google' => self::env('GOOGLE_MAPS_SERVER_API_KEY', ''),
            'gaode' => self::env('AMAP_WEB_SERVICE_API_KEY', ''),
            'tianditu' => self::env('TIANDITU_SERVER_API_KEY', ''),
            'azure' => self::env('AZURE_MAPS_SUBSCRIPTION_KEY', ''),
        ];

        if ($environment === 'production') {
            if (strlen($secret) < 32) {
                throw new InvalidArgumentException('BFF_SESSION_HMAC_SECRET must contain at least 32 characters.');
            }
            if ($origins === []) {
                throw new InvalidArgumentException('BFF_ALLOWED_ORIGINS must contain at least one exact HTTPS origin.');
            }
            foreach ($origins as $origin) {
                $parts = parse_url($origin);
                if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || !isset($parts['host']) || isset($parts['path']) || isset($parts['query'])) {
                    throw new InvalidArgumentException('Every production BFF_ALLOWED_ORIGINS entry must be an exact HTTPS origin.');
                }
            }
            foreach ($enabledProviders as $provider) {
                if (!array_key_exists($provider, $providerKeys)) {
                    throw new InvalidArgumentException('BFF_ENABLED_PROVIDERS contains an unsupported provider.');
                }
                if ($providerKeys[$provider] === '') {
                    throw new InvalidArgumentException('Every enabled production provider must have a server credential.');
                }
            }
        }

        return new self([
            'environment' => $environment,
            'allowed_origins' => $origins,
            'require_origin_for_anonymous' => self::boolEnv('BFF_REQUIRE_ORIGIN_FOR_ANONYMOUS', true),
            'session_secret' => $secret,
            'session_cookie' => self::env('BFF_SESSION_COOKIE', '__Host-travelplanner_session'),
            'session_ttl_seconds' => self::intEnv('BFF_SESSION_TTL_SECONDS', 3600, 300, 86_400),
            'bearer_tokens' => $tokens,
            'db_path' => self::env('BFF_DB_PATH', dirname(__DIR__) . '/var/bff.sqlite'),
            'user_rate_per_minute' => self::intEnv('BFF_USER_RATE_PER_MINUTE', 120, 1, 100_000),
            'anonymous_rate_per_minute' => self::intEnv('BFF_ANON_RATE_PER_MINUTE', 30, 1, 100_000),
            'global_rate_per_minute' => self::intEnv('BFF_GLOBAL_RATE_PER_MINUTE', 1200, 1, 1_000_000),
            'upstream_connect_timeout_ms' => self::intEnv('BFF_UPSTREAM_CONNECT_TIMEOUT_MS', 800, 100, 30_000),
            'upstream_timeout_ms' => self::intEnv('BFF_UPSTREAM_TIMEOUT_MS', 4000, 200, 60_000),
            'upstream_max_response_bytes' => self::intEnv('BFF_UPSTREAM_MAX_RESPONSE_BYTES', 5_242_880, 65_536, 20_971_520),
            'provider_concurrency' => self::intEnv('BFF_PROVIDER_CONCURRENCY', 8, 1, 1000),
            'concurrency_lease_seconds' => self::intEnv('BFF_CONCURRENCY_LEASE_SECONDS', 10, 1, 120),
            'cache_ttl_places' => self::intEnv('BFF_CACHE_TTL_PLACES_SECONDS', 300, 0, 86_400),
            'cache_ttl_routes' => self::intEnv('BFF_CACHE_TTL_ROUTES_SECONDS', 120, 0, 86_400),
            'cache_ttl_matrix' => self::intEnv('BFF_CACHE_TTL_MATRIX_SECONDS', 120, 0, 86_400),
            'cache_ttl_static_maps' => self::intEnv('BFF_CACHE_TTL_STATIC_MAPS_SECONDS', 600, 0, 86_400),
            'circuit_failure_threshold' => self::intEnv('BFF_CIRCUIT_FAILURE_THRESHOLD', 5, 1, 100),
            'circuit_reset_seconds' => self::intEnv('BFF_CIRCUIT_RESET_SECONDS', 30, 1, 3600),
            'max_request_bytes' => self::intEnv('BFF_MAX_REQUEST_BYTES', 65_536, 1024, 1_048_576),
            'enabled_providers' => $enabledProviders,
            'credential_version' => self::env('BFF_CREDENTIAL_VERSION', 'v1'),
            'provider_keys' => $providerKeys,
        ]);
    }

    public function getString(string $key): string
    {
        return (string) ($this->values[$key] ?? '');
    }

    public function getInt(string $key): int
    {
        return (int) ($this->values[$key] ?? 0);
    }

    public function getBool(string $key): bool
    {
        return (bool) ($this->values[$key] ?? false);
    }

    /** @return array<mixed> */
    public function getArray(string $key): array
    {
        $value = $this->values[$key] ?? [];
        return is_array($value) ? $value : [];
    }

    public function providerKey(string $provider): string
    {
        $keys = $this->getArray('provider_keys');
        return is_string($keys[$provider] ?? null) ? $keys[$provider] : '';
    }

    private static function env(string $name, string $default): string
    {
        $value = getenv($name);
        return $value === false ? $default : trim($value);
    }

    private static function intEnv(string $name, int $default, int $min, int $max): int
    {
        $raw = self::env($name, (string) $default);
        if (filter_var($raw, FILTER_VALIDATE_INT) === false) {
            throw new InvalidArgumentException($name . ' must be an integer.');
        }
        $value = (int) $raw;
        if ($value < $min || $value > $max) {
            throw new InvalidArgumentException($name . ' is outside its allowed range.');
        }
        return $value;
    }

    private static function boolEnv(string $name, bool $default): bool
    {
        $raw = self::env($name, $default ? 'true' : 'false');
        $value = filter_var($raw, FILTER_VALIDATE_BOOL, FILTER_NULL_ON_FAILURE);
        if ($value === null) {
            throw new InvalidArgumentException($name . ' must be true or false.');
        }
        return $value;
    }

    /** @return list<string> */
    private static function csv(string $value): array
    {
        if ($value === '') {
            return [];
        }
        return array_values(array_unique(array_filter(array_map('trim', explode(',', $value)), static fn (string $item): bool => $item !== '')));
    }

    /** @return list<array{token: string, subject: string, tenant: string}> */
    private static function decodeBearerTokens(string $json): array
    {
        try {
            $decoded = json_decode($json, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException $exception) {
            throw new InvalidArgumentException('BFF_BEARER_TOKENS_JSON is invalid JSON.', previous: $exception);
        }
        if (!is_array($decoded) || !array_is_list($decoded)) {
            throw new InvalidArgumentException('BFF_BEARER_TOKENS_JSON must be a JSON array.');
        }
        $result = [];
        foreach ($decoded as $entry) {
            if (!is_array($entry) || !is_string($entry['token'] ?? null) || strlen($entry['token']) < 16
                || !is_string($entry['subject'] ?? null) || !preg_match('/^[A-Za-z0-9._:@-]{1,128}$/D', $entry['subject'])
                || !is_string($entry['tenant'] ?? null) || !preg_match('/^[A-Za-z0-9._:@-]{1,128}$/D', $entry['tenant'])) {
                throw new InvalidArgumentException('Each bearer token entry requires token (16+ characters), subject and tenant.');
            }
            $result[] = ['token' => $entry['token'], 'subject' => $entry['subject'], 'tenant' => $entry['tenant']];
        }
        return $result;
    }
}

final class Id
{
    public static function randomHex(int $bytes = 16): string
    {
        return bin2hex(random_bytes($bytes));
    }

    public static function actorHash(string $value): string
    {
        return substr(hash('sha256', $value), 0, 16);
    }

    public static function base64UrlEncode(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    public static function base64UrlDecode(string $value): string|false
    {
        if (!preg_match('/^[A-Za-z0-9_-]+$/D', $value)) {
            return false;
        }
        $padding = (4 - strlen($value) % 4) % 4;
        return base64_decode(strtr($value . str_repeat('=', $padding), '-_', '+/'), true);
    }
}

final class Redactor
{
    private const SENSITIVE_KEY = '/(?:api[-_]?key|subscription[-_]?key|authorization|cookie|secret|token|password|settings|(?:^|[-_])(?:url|uri|endpoint)$)/i';

    public static function sanitize(mixed $value, int $depth = 0): mixed
    {
        if ($depth > 8) {
            return '[TRUNCATED]';
        }
        if (is_array($value)) {
            $clean = [];
            $count = 0;
            foreach ($value as $key => $item) {
                if (++$count > 100) {
                    $clean['_truncated'] = true;
                    break;
                }
                $keyString = (string) $key;
                $clean[$key] = preg_match(self::SENSITIVE_KEY, $keyString)
                    ? '[REDACTED]'
                    : self::sanitize($item, $depth + 1);
            }
            return $clean;
        }
        if (is_object($value)) {
            return '[OBJECT:' . $value::class . ']';
        }
        if (!is_string($value)) {
            return $value;
        }

        $text = substr($value, 0, 2048);
        $text = preg_replace('~https?://[^\s"\'<>]+~i', '[REDACTED_URL]', $text) ?? '[REDACTED]';
        $text = preg_replace('/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i', 'Bearer [REDACTED]', $text) ?? '[REDACTED]';
        $text = preg_replace('/([?&](?:key|api_key|apikey|subscription-key)=)[^&\s]+/i', '$1[REDACTED]', $text) ?? '[REDACTED]';
        return $text;
    }
}

final class JsonLogger
{
    /** @var resource */
    private $stream;
    private string $environment;

    /** @param resource|null $stream */
    public function __construct($stream = null, string $environment = 'production')
    {
        $this->stream = is_resource($stream) ? $stream : STDERR;
        $this->environment = $environment;
    }

    /** @param array<string, mixed> $context */
    public function info(string $event, array $context = []): void
    {
        $this->write('info', $event, $context);
    }

    /** @param array<string, mixed> $context */
    public function warning(string $event, array $context = []): void
    {
        $this->write('warning', $event, $context);
    }

    /** @param array<string, mixed> $context */
    public function error(string $event, array $context = []): void
    {
        $this->write('error', $event, $context);
    }

    /** @param array<string, mixed> $context */
    private function write(string $level, string $event, array $context): void
    {
        $record = array_merge([
            'timestamp' => gmdate('c'),
            'level' => $level,
            'event' => preg_replace('/[^a-z0-9_.-]/i', '_', $event),
            'service' => 'travelplanner-map-bff',
            'environment' => $this->environment,
        ], is_array(Redactor::sanitize($context)) ? Redactor::sanitize($context) : []);
        $json = json_encode($record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if (is_string($json)) {
            fwrite($this->stream, $json . "\n");
        }
    }
}
