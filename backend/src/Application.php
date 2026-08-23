<?php

declare(strict_types=1);

namespace TravelPlanner\Bff;

final class Application
{
    private DtoValidator $validator;

    public function __construct(
        private readonly Config $config,
        private readonly Clock $clock,
        private readonly JsonLogger $logger,
        private readonly StateStore $state,
        private readonly Authenticator $authenticator,
        private readonly ProviderRegistry $providers,
    ) {
        $this->validator = new DtoValidator();
    }

    public function handle(Request $request): Response
    {
        $started = $this->clock->nowFloat();
        $requestId = $this->requestId($request);
        try {
            if ($request->method === 'OPTIONS') {
                return $this->withRequestId(new Response(204, '', ['Cache-Control' => 'no-store', 'Allow' => 'POST, OPTIONS']), $requestId);
            }
            if ($request->method !== 'POST') throw new ApiException(405, 'METHOD_NOT_ALLOWED', 'Only POST is supported.', ['Allow' => 'POST, OPTIONS']);
            if ($request->path === '/api/v1/session') {
                $response = $this->authenticator->createAnonymousSession($request);
                $this->logCompletion($requestId, 'session', 201, $started, null, null, false);
                return $this->withRequestId($response, $requestId);
            }

            $endpoint = match ($request->path) {
                '/api/v1/places/search' => 'places',
                '/api/v1/routes' => 'routes',
                '/api/v1/route-matrix' => 'matrix',
                '/api/v1/static-maps' => 'static_maps',
                default => throw new ApiException(404, 'NOT_FOUND', 'API endpoint does not exist.'),
            };

            $actor = $this->authenticator->authenticate($request);
            $this->enforceRateLimits($actor, $endpoint);
            $input = $request->json($this->config->getInt('max_request_bytes'));
            $dto = match ($endpoint) {
                'places' => $this->validator->places($input),
                'routes' => $this->validator->route($input),
                'matrix' => $this->validator->matrix($input),
                'static_maps' => $this->validator->staticMap($input),
            };
            $provider = $dto['provider'];
            if (!in_array($provider, $this->config->getArray('enabled_providers'), true)) {
                throw new ApiException(403, 'PROVIDER_FORBIDDEN', 'Requested map provider is not enabled.');
            }

            // Authorization and provider policy are evaluated before cache lookup.
            $adapter = $this->providers->get($provider);
            if (!$adapter->isConfigured()) {
                throw new ApiException(503, 'PROVIDER_NOT_CONFIGURED', 'Map provider is not configured.');
            }
            $cacheKey = $this->cacheKey($actor, $endpoint, $dto);
            $cached = $this->state->cacheGet($cacheKey, $this->clock->now());
            if ($cached !== null) {
                $this->logCompletion($requestId, $endpoint, 200, $started, $provider, $actor, true);
                return $this->cachedResponse($cached, $requestId);
            }

            $this->state->assertCircuitClosed($provider, $this->clock->now());
            $leaseKey = 'provider:' . $provider;
            if (!$this->state->acquireLease($leaseKey, $this->config->getInt('provider_concurrency'), $this->clock->now(), $this->config->getInt('concurrency_lease_seconds'))) {
                throw new ApiException(503, 'CONCURRENCY_LIMITED', 'Map provider is busy.', ['Retry-After' => '1']);
            }

            try {
                $result = match ($endpoint) {
                    'places' => ['content_type' => 'application/json', 'body' => $this->jsonBody($adapter->searchPlaces($dto), $requestId)],
                    'routes' => ['content_type' => 'application/json', 'body' => $this->jsonBody($adapter->route($dto), $requestId)],
                    'matrix' => ['content_type' => 'application/json', 'body' => $this->jsonBody($adapter->routeMatrix($dto), $requestId)],
                    'static_maps' => $adapter->staticMap($dto),
                };
                $this->state->providerSucceeded($provider);
            } catch (ApiException $error) {
                if ($error->countsAsProviderFailure) {
                    $this->state->providerFailed($provider, $this->config->getInt('circuit_failure_threshold'), $this->clock->now() + $this->config->getInt('circuit_reset_seconds'));
                }
                throw $error;
            } finally {
                $this->state->releaseLease($leaseKey);
            }

            $this->assertSafeProviderResult($result, $endpoint);
            $ttl = $this->config->getInt(match ($endpoint) {
                'places' => 'cache_ttl_places', 'routes' => 'cache_ttl_routes', 'matrix' => 'cache_ttl_matrix', 'static_maps' => 'cache_ttl_static_maps',
            });
            if ($ttl > 0) $this->state->cachePut($cacheKey, $result['content_type'], $result['body'], $this->clock->now() + $ttl);
            $this->logCompletion($requestId, $endpoint, 200, $started, $provider, $actor, false);
            return $this->contentResponse($result, $requestId);
        } catch (ApiException $error) {
            $this->logger->warning('request.rejected', ['request_id' => $requestId, 'status' => $error->status, 'error_code' => $error->errorCode, 'duration_ms' => (int) (($this->clock->nowFloat() - $started) * 1000)]);
            return $this->withRequestId(Response::json($error->status, ['code' => $error->errorCode, 'message' => $error->getMessage(), 'requestId' => $requestId], array_map('strval', $error->responseHeaders)), $requestId);
        } catch (\Throwable) {
            $this->logger->error('request.failed', ['request_id' => $requestId, 'status' => 500, 'error_code' => 'INTERNAL_ERROR']);
            return $this->withRequestId(Response::json(500, ['code' => 'INTERNAL_ERROR', 'message' => 'Internal server error.', 'requestId' => $requestId]), $requestId);
        }
    }

    private function enforceRateLimits(Actor $actor, string $endpoint): void
    {
        $now = $this->clock->now();
        if (!$this->state->consumeRate('global:' . $endpoint, $this->config->getInt('global_rate_per_minute'), $now)) $this->limited();
        $limit = $actor->type === 'user' ? $this->config->getInt('user_rate_per_minute') : $this->config->getInt('anonymous_rate_per_minute');
        if (!$this->state->consumeRate('actor:' . hash('sha256', $actor->scope()) . ':' . $endpoint, $limit, $now)) $this->limited();
    }

    private function limited(): never
    {
        throw new ApiException(429, 'RATE_LIMITED', 'Rate limit exceeded.', ['Retry-After' => (string) (60 - ($this->clock->now() % 60))]);
    }

    /** @param array<string, mixed> $dto */
    private function cacheKey(Actor $actor, string $endpoint, array $dto): string
    {
        $normalized = json_encode($dto, JSON_PRESERVE_ZERO_FRACTION | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        return hash('sha256', implode('|', ['bff-v1', $this->config->getString('credential_version'), $actor->scope(), $endpoint, $normalized]));
    }

    /** @param array<string, mixed> $data */
    private function jsonBody(array $data, string $requestId): string
    {
        return json_encode(['data' => $data, 'meta' => ['requestId' => $requestId, 'generatedAt' => gmdate('c', $this->clock->now())]], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    }

    /** @param array{content_type: string, body: string} $result */
    private function assertSafeProviderResult(array $result, string $endpoint): void
    {
        if (strlen($result['body']) > $this->config->getInt('upstream_max_response_bytes')) throw new ApiException(502, 'UPSTREAM_INVALID_RESPONSE', 'Map provider response exceeds the safe limit.', countsAsProviderFailure: true);
        if ($endpoint === 'static_maps' && !in_array($result['content_type'], ['image/png', 'image/jpeg'], true)) throw new ApiException(502, 'UPSTREAM_INVALID_RESPONSE', 'Map provider returned invalid image data.', countsAsProviderFailure: true);
        if ($endpoint !== 'static_maps' && $result['content_type'] !== 'application/json') throw new ApiException(502, 'UPSTREAM_INVALID_RESPONSE', 'Map provider returned invalid data.', countsAsProviderFailure: true);
    }

    /** @param array{content_type: string, body: string} $result */
    private function contentResponse(array $result, string $requestId): Response
    {
        return new Response(200, $result['body'], ['Content-Type' => $result['content_type'], 'Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff', 'X-Request-Id' => $requestId]);
    }

    /** @param array{content_type: string, body: string} $cached */
    private function cachedResponse(array $cached, string $requestId): Response
    {
        $body = $cached['body'];
        if ($cached['content_type'] === 'application/json') {
            $decoded = json_decode($body, true);
            if (is_array($decoded) && isset($decoded['meta']) && is_array($decoded['meta'])) {
                $decoded['meta']['requestId'] = $requestId;
                $body = json_encode($decoded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
            }
        }
        return new Response(200, $body, ['Content-Type' => $cached['content_type'], 'Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff', 'X-Request-Id' => $requestId, 'X-BFF-Cache' => 'HIT']);
    }

    private function requestId(Request $request): string
    {
        $candidate = $request->header('X-Request-Id');
        return preg_match('/^[A-Za-z0-9._:-]{8,64}$/D', $candidate) ? $candidate : Id::randomHex(16);
    }

    private function withRequestId(Response $response, string $requestId): Response
    {
        return new Response($response->status, $response->body, array_merge($response->headers, ['X-Request-Id' => $requestId]));
    }

    private function logCompletion(string $requestId, string $endpoint, int $status, float $started, ?string $provider, ?Actor $actor, bool $cacheHit): void
    {
        $context = ['request_id' => $requestId, 'endpoint_name' => $endpoint, 'status' => $status, 'duration_ms' => (int) (($this->clock->nowFloat() - $started) * 1000), 'cache_status' => $cacheHit ? 'hit' : 'miss'];
        if ($provider !== null) $context['provider'] = $provider;
        if ($actor !== null) $context['actor_type'] = $actor->type;
        $this->logger->info('request.completed', $context);
    }
}
