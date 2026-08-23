<?php

declare(strict_types=1);

use TravelPlanner\Bff\Actor;
use TravelPlanner\Bff\ApiException;
use TravelPlanner\Bff\Application;
use TravelPlanner\Bff\Authenticator;
use TravelPlanner\Bff\Clock;
use TravelPlanner\Bff\Config;
use TravelPlanner\Bff\CurlUpstreamClient;
use TravelPlanner\Bff\JsonLogger;
use TravelPlanner\Bff\ProviderAdapter;
use TravelPlanner\Bff\ProviderRegistry;
use TravelPlanner\Bff\Redactor;
use TravelPlanner\Bff\Request;
use TravelPlanner\Bff\Response;
use TravelPlanner\Bff\StateStore;

require_once dirname(__DIR__) . '/src/Support.php';
require_once dirname(__DIR__) . '/src/Http.php';
require_once dirname(__DIR__) . '/src/StateStore.php';
require_once dirname(__DIR__) . '/src/Provider.php';
require_once dirname(__DIR__) . '/src/Security.php';
require_once dirname(__DIR__) . '/src/Application.php';

final class TestClock implements Clock
{
    public int $time = 1_800_000_000;
    public function now(): int { return $this->time; }
    public function nowFloat(): float { return (float) $this->time; }
}

final class FakeAdapter implements ProviderAdapter
{
    public int $calls = 0;
    public bool $timeout = false;
    public bool $fail = false;
    public function __construct(private readonly string $provider = 'google') {}
    public function id(): string { return $this->provider; }
    public function isConfigured(): bool { return true; }
    public function searchPlaces(array $dto): array { $this->touch(); return ['provider' => $this->provider, 'places' => [['id' => 'p1', 'name' => 'Museum', 'address' => 'Safe', 'location' => ['lat' => 31.2, 'lng' => 121.4]]]]; }
    public function route(array $dto): array { $this->touch(); return ['provider' => $this->provider, 'distanceMeters' => 1200, 'durationSeconds' => 300, 'polyline' => [$dto['origin'], $dto['destination']]]; }
    public function routeMatrix(array $dto): array { $this->touch(); return ['provider' => $this->provider, 'matrix' => [[['status' => 'OK', 'distanceMeters' => 1200, 'durationSeconds' => 300]]]]; }
    public function staticMap(array $dto): array { $this->touch(); return ['content_type' => 'image/png', 'body' => "\x89PNG\r\n\x1a\nFAKE"]; }
    private function touch(): void {
        $this->calls++;
        if ($this->timeout) throw new ApiException(504, 'UPSTREAM_TIMEOUT', 'Map provider timed out.', countsAsProviderFailure: true);
        if ($this->fail) throw new ApiException(502, 'UPSTREAM_UNAVAILABLE', 'Map provider is unavailable.', countsAsProviderFailure: true);
    }
}

final class UnconfiguredAdapter implements ProviderAdapter
{
    public int $calls = 0;
    public function id(): string { return 'google'; }
    public function isConfigured(): bool { return false; }
    public function searchPlaces(array $dto): array { $this->calls++; return []; }
    public function route(array $dto): array { $this->calls++; return []; }
    public function routeMatrix(array $dto): array { $this->calls++; return []; }
    public function staticMap(array $dto): array { $this->calls++; return ['content_type' => 'image/png', 'body' => '']; }
}

/** @return array{Application, StateStore, FakeAdapter, resource, string} */
function makeApp(array $overrides = []): array
{
    $path = tempnam(sys_get_temp_dir(), 'travel-bff-test-');
    if ($path === false) throw new RuntimeException('tempnam failed');
    $stream = fopen('php://memory', 'w+');
    if ($stream === false) throw new RuntimeException('memory stream failed');
    $config = new Config(array_replace_recursive([
        'allowed_origins' => ['https://travel.test'],
        'session_secret' => str_repeat('s', 64),
        'db_path' => $path,
        'anonymous_rate_per_minute' => 50,
        'user_rate_per_minute' => 50,
        'global_rate_per_minute' => 500,
        'provider_concurrency' => 2,
        'circuit_failure_threshold' => 2,
        'enabled_providers' => ['google'],
        'bearer_tokens' => [
            ['token' => 'tenant-a-token-value', 'subject' => 'alice', 'tenant' => 'tenant-a'],
            ['token' => 'tenant-b-token-value', 'subject' => 'bob', 'tenant' => 'tenant-b'],
        ],
    ], $overrides));
    $clock = new TestClock();
    $state = new StateStore($path);
    $adapter = new FakeAdapter();
    $app = new Application($config, $clock, new JsonLogger($stream, 'test'), $state, new Authenticator($config, $clock), new ProviderRegistry([$adapter]));
    return [$app, $state, $adapter, $stream, $path];
}

/** @param array<string, mixed> $body @param array<string, string> $headers */
function apiRequest(string $path, array $body, array $headers = [], array $cookies = []): Request
{
    return new Request('POST', $path, array_merge(['Content-Type' => 'application/json'], $headers), json_encode($body, JSON_THROW_ON_ERROR), $cookies);
}

function bearer(string $token = 'tenant-a-token-value'): array { return ['Authorization' => 'Bearer ' . $token]; }
function routeDto(): array { return ['provider' => 'google', 'origin' => ['lat' => 31.2, 'lng' => 121.4], 'destination' => ['lat' => 31.3, 'lng' => 121.5], 'travelMode' => 'DRIVING']; }
function decode(Response $response): array { return json_decode($response->body, true, 32, JSON_THROW_ON_ERROR); }
function expect(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }

$tests = [];
$tests['authentication and provider authorization fail closed'] = function (): void {
    [$app, , $adapter, , $path] = makeApp();
    expect($app->handle(apiRequest('/api/v1/routes', routeDto()))->status === 403, 'missing origin/session must fail');
    expect($app->handle(apiRequest('/api/v1/routes', routeDto(), bearer('not-a-valid-token')))->status === 401, 'bad bearer must fail');
    $dto = routeDto(); $dto['provider'] = 'azure';
    expect($app->handle(apiRequest('/api/v1/routes', $dto, bearer()))->status === 403, 'disabled provider must fail');
    expect($adapter->calls === 0, 'unauthorized requests reached provider');
    unlink($path);
};

$tests['anonymous session cookie is bound to supplied UUID'] = function (): void {
    [$app, , $adapter, , $path] = makeApp();
    $id = '123e4567-e89b-42d3-a456-426614174000';
    $session = $app->handle(apiRequest('/api/v1/session', ['sessionId' => $id], ['Origin' => 'https://travel.test', 'Sec-Fetch-Site' => 'same-origin']));
    expect($session->status === 201, 'session issue failed');
    [$cookieName, $cookieValue] = explode('=', explode(';', $session->headers['Set-Cookie'])[0], 2);
    $response = $app->handle(apiRequest('/api/v1/routes', routeDto(), ['Origin' => 'https://travel.test', 'Sec-Fetch-Site' => 'same-origin', 'X-Anonymous-Session' => $id], [$cookieName => $cookieValue]));
    expect($response->status === 200 && $adapter->calls === 1, 'valid anonymous session failed');
    $wrong = $app->handle(apiRequest('/api/v1/routes', routeDto(), ['Origin' => 'https://travel.test', 'X-Anonymous-Session' => '123e4567-e89b-42d3-a456-426614174001'], [$cookieName => $cookieValue]));
    expect($wrong->status === 401, 'session ID mismatch was accepted');
    unlink($path);
};

$tests['anonymous session has its own rate-limit bucket before cache'] = function (): void {
    [$app, , $adapter, , $path] = makeApp(['anonymous_rate_per_minute' => 2]);
    $id = '123e4567-e89b-42d3-a456-426614174000';
    $originHeaders = ['Origin' => 'https://travel.test', 'Sec-Fetch-Site' => 'same-origin'];
    $session = $app->handle(apiRequest('/api/v1/session', ['sessionId' => $id], $originHeaders));
    [$cookieName, $cookieValue] = explode('=', explode(';', $session->headers['Set-Cookie'])[0], 2);
    $headers = $originHeaders + ['X-Anonymous-Session' => $id];
    $cookies = [$cookieName => $cookieValue];
    expect($app->handle(apiRequest('/api/v1/routes', routeDto(), $headers, $cookies))->status === 200, 'first anonymous request failed');
    expect($app->handle(apiRequest('/api/v1/routes', routeDto(), $headers, $cookies))->status === 200, 'second anonymous cache hit failed');
    expect($app->handle(apiRequest('/api/v1/routes', routeDto(), $headers, $cookies))->status === 429, 'anonymous rate limit was bypassed');
    expect($adapter->calls === 1, 'anonymous cache/rate ordering is wrong');
    unlink($path);
};

$tests['unknown URL and API fields cannot create an open proxy'] = function (): void {
    [$app, , $adapter, , $path] = makeApp();
    foreach (['url', 'endpoint', 'apiKey', 'headers', 'path'] as $field) {
        $dto = routeDto(); $dto[$field] = 'http://169.254.169.254/latest/meta-data';
        $response = $app->handle(apiRequest('/api/v1/routes', $dto, bearer()));
        expect($response->status === 422 && decode($response)['code'] === 'INVALID_ARGUMENT', $field . ' was accepted');
    }
    expect($app->handle(apiRequest('/api/v1/proxy', ['url' => 'https://example.test'], bearer()))->status === 404, 'proxy endpoint exists');
    expect($adapter->calls === 0, 'rejected proxy request reached provider');
    unlink($path);
};

$tests['upstream transport rejects non-provider hosts before network access'] = function (): void {
    $client = new CurlUpstreamClient(new Config());
    try {
        $client->request('GET', 'https://169.254.169.254/latest/meta-data');
        throw new RuntimeException('metadata host was accepted');
    } catch (ApiException $error) {
        expect($error->errorCode === 'UPSTREAM_POLICY_VIOLATION', 'wrong transport policy error');
    }
    try {
        $client->request('GET', 'https://evil.example.test/maps');
        throw new RuntimeException('arbitrary public host was accepted');
    } catch (ApiException $error) {
        expect($error->errorCode === 'UPSTREAM_POLICY_VIOLATION', 'arbitrary host reached transport');
    }
};

$tests['unconfigured provider is rejected before cache and provider execution'] = function (): void {
    $path = tempnam(sys_get_temp_dir(), 'travel-bff-test-');
    if ($path === false) throw new RuntimeException('tempnam failed');
    $stream = fopen('php://memory', 'w+');
    if ($stream === false) throw new RuntimeException('memory stream failed');
    $config = new Config([
        'session_secret' => str_repeat('s', 64),
        'db_path' => $path,
        'enabled_providers' => ['google'],
        'bearer_tokens' => [['token' => 'tenant-a-token-value', 'subject' => 'alice', 'tenant' => 'tenant-a']],
    ]);
    $clock = new TestClock();
    $adapter = new UnconfiguredAdapter();
    $app = new Application($config, $clock, new JsonLogger($stream, 'test'), new StateStore($path), new Authenticator($config, $clock), new ProviderRegistry([$adapter]));
    $response = $app->handle(apiRequest('/api/v1/places/search', [
        'provider' => 'google',
        'query' => 'museum',
        'limit' => 10,
        'language' => 'en-US',
        'region' => 'US',
        'locationBias' => ['lat' => 31.2, 'lng' => 121.4, 'radiusMeters' => 10000],
    ], bearer()));
    expect($response->status === 503 && decode($response)['code'] === 'PROVIDER_NOT_CONFIGURED', 'unconfigured provider did not return the configuration error');
    expect($adapter->calls === 0, 'unconfigured provider executed an upstream operation');
    unlink($path);
};

$tests['per-actor rate limit runs before cache'] = function (): void {
    [$app, , $adapter, , $path] = makeApp(['user_rate_per_minute' => 2]);
    expect($app->handle(apiRequest('/api/v1/routes', routeDto(), bearer()))->status === 200, 'first request failed');
    expect($app->handle(apiRequest('/api/v1/routes', routeDto(), bearer()))->status === 200, 'cached second request failed');
    $third = $app->handle(apiRequest('/api/v1/routes', routeDto(), bearer()));
    expect($third->status === 429 && isset($third->headers['Retry-After']), 'rate limit did not reject third request');
    expect($adapter->calls === 1, 'cache miss count is wrong');
    unlink($path);
};

$tests['cache is isolated by tenant and actor'] = function (): void {
    [$app, , $adapter, , $path] = makeApp();
    expect($app->handle(apiRequest('/api/v1/routes', routeDto(), bearer('tenant-a-token-value')))->status === 200, 'tenant A failed');
    expect($app->handle(apiRequest('/api/v1/routes', routeDto(), bearer('tenant-a-token-value')))->headers['X-BFF-Cache'] === 'HIT', 'tenant A missed cache');
    $tenantB = $app->handle(apiRequest('/api/v1/routes', routeDto(), bearer('tenant-b-token-value')));
    expect($tenantB->status === 200 && !isset($tenantB->headers['X-BFF-Cache']), 'tenant B read tenant A cache');
    expect($adapter->calls === 2, 'cache isolation call count is wrong');
    unlink($path);
};

$tests['provider timeout opens circuit after threshold'] = function (): void {
    [$app, , $adapter, , $path] = makeApp(['circuit_failure_threshold' => 2]);
    $adapter->timeout = true;
    expect($app->handle(apiRequest('/api/v1/routes', routeDto(), bearer()))->status === 504, 'first timeout missing');
    expect($app->handle(apiRequest('/api/v1/routes', routeDto(), bearer()))->status === 504, 'second timeout missing');
    $third = $app->handle(apiRequest('/api/v1/routes', routeDto(), bearer()));
    expect($third->status === 503 && decode($third)['code'] === 'CIRCUIT_OPEN', 'circuit did not open');
    expect($adapter->calls === 2, 'open circuit reached provider');
    unlink($path);
};

$tests['provider concurrency lease rejects excess work'] = function (): void {
    [$app, $state, $adapter, , $path] = makeApp(['provider_concurrency' => 1]);
    expect($state->acquireLease('provider:google', 1, 1_800_000_000, 10), 'test lease failed');
    $response = $app->handle(apiRequest('/api/v1/routes', routeDto(), bearer()));
    expect($response->status === 503 && decode($response)['code'] === 'CONCURRENCY_LIMITED', 'concurrency limit failed');
    expect($adapter->calls === 0, 'concurrency rejected call reached provider');
    unlink($path);
};

$tests['static map returns bytes and never redirects to provider'] = function (): void {
    [$app, , $adapter, , $path] = makeApp();
    $dto = ['provider' => 'google', 'points' => [['lat' => 31.2, 'lng' => 121.4]], 'width' => 800, 'height' => 600, 'drawPath' => true];
    $response = $app->handle(apiRequest('/api/v1/static-maps', $dto, bearer()));
    expect($response->status === 200 && $response->headers['Content-Type'] === 'image/png', 'static image missing');
    expect(!isset($response->headers['Location']) && str_starts_with($response->body, "\x89PNG"), 'provider URL was exposed');
    unlink($path);
};

$tests['logs recursively redact keys tokens settings and full URLs'] = function (): void {
    $canary = 'SERVER_WEB_KEY_CANARY_93f8';
    $stream = fopen('php://memory', 'w+');
    $logger = new JsonLogger($stream, 'test');
    $logger->error('canary', ['endpoint_name' => 'routes', 'apiKey' => $canary, 'authorization' => 'Bearer secret-token', 'settings' => ['nested' => $canary], 'message' => 'failed https://maps.example/path?key=' . $canary]);
    rewind($stream); $log = stream_get_contents($stream);
    expect(!str_contains($log, $canary) && !str_contains($log, 'secret-token') && !str_contains($log, 'https://'), 'sensitive log value leaked');
    expect(substr_count($log, '[REDACTED]') >= 3 && str_contains($log, '[REDACTED_URL]'), 'redaction markers missing');
    expect(str_contains($log, '"endpoint_name":"routes"'), 'safe endpoint enum was lost');
};

$failures = 0;
foreach ($tests as $name => $test) {
    try {
        $test();
        fwrite(STDOUT, "PASS {$name}\n");
    } catch (Throwable $error) {
        $failures++;
        fwrite(STDERR, "FAIL {$name}: {$error->getMessage()}\n");
    }
}
fwrite(STDOUT, sprintf("\n%d tests, %d failures\n", count($tests), $failures));
exit($failures === 0 ? 0 : 1);
