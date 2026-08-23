<?php

declare(strict_types=1);

namespace TravelPlanner\Bff;

final class Authenticator
{
    public function __construct(private readonly Config $config, private readonly Clock $clock)
    {
    }

    public function createAnonymousSession(Request $request): Response
    {
        $this->assertOrigin($request);
        $body = $request->json($this->config->getInt('max_request_bytes'));
        if (array_keys($body) !== ['sessionId'] || !is_string($body['sessionId']) || !$this->validUuid($body['sessionId'])) {
            throw new ApiException(422, 'INVALID_ARGUMENT', 'sessionId must be a UUID.');
        }
        $expiresAt = $this->clock->now() + $this->config->getInt('session_ttl_seconds');
        $payload = $expiresAt . '.' . strtolower($body['sessionId']);
        $signature = Id::base64UrlEncode(hash_hmac('sha256', $payload, $this->config->getString('session_secret'), true));
        $cookieValue = Id::base64UrlEncode($payload) . '.' . $signature;
        $cookie = $this->config->getString('session_cookie') . '=' . $cookieValue
            . '; Path=/; Max-Age=' . $this->config->getInt('session_ttl_seconds')
            . '; Secure; HttpOnly; SameSite=Strict';
        return Response::json(201, ['data' => ['sessionId' => strtolower($body['sessionId']), 'expiresAt' => gmdate('c', $expiresAt)]], ['Set-Cookie' => $cookie]);
    }

    public function authenticate(Request $request): Actor
    {
        $authorization = $request->header('Authorization');
        if (str_starts_with($authorization, 'Bearer ')) {
            $token = substr($authorization, 7);
            foreach ($this->config->getArray('bearer_tokens') as $entry) {
                if (is_array($entry) && is_string($entry['token'] ?? null) && hash_equals($entry['token'], $token)) {
                    return new Actor('user', (string) $entry['subject'], (string) $entry['tenant']);
                }
            }
            throw new ApiException(401, 'UNAUTHENTICATED', 'Authentication is required.', ['WWW-Authenticate' => 'Bearer']);
        }

        $this->assertOrigin($request);
        $sessionId = strtolower($request->header('X-Anonymous-Session'));
        if (!$this->validUuid($sessionId)) {
            throw new ApiException(401, 'ANONYMOUS_SESSION_REQUIRED', 'A valid anonymous session is required.');
        }
        $cookie = $request->cookies[$this->config->getString('session_cookie')] ?? '';
        if (!is_string($cookie) || !$this->verifyCookie($cookie, $sessionId)) {
            throw new ApiException(401, 'ANONYMOUS_SESSION_INVALID', 'Anonymous session is invalid or expired.');
        }
        return new Actor('anonymous', $sessionId, 'public');
    }

    private function assertOrigin(Request $request): void
    {
        if (!$this->config->getBool('require_origin_for_anonymous')) return;
        $origin = $request->header('Origin');
        if ($origin === '' || !in_array($origin, $this->config->getArray('allowed_origins'), true)) {
            throw new ApiException(403, 'ORIGIN_REJECTED', 'Request origin is not allowed.');
        }
        $fetchSite = strtolower($request->header('Sec-Fetch-Site'));
        if ($fetchSite === 'cross-site') {
            throw new ApiException(403, 'ORIGIN_REJECTED', 'Cross-site requests are not allowed.');
        }
    }

    private function verifyCookie(string $cookie, string $sessionId): bool
    {
        $parts = explode('.', $cookie);
        if (count($parts) !== 2) return false;
        $payload = Id::base64UrlDecode($parts[0]);
        $signature = Id::base64UrlDecode($parts[1]);
        if (!is_string($payload) || !is_string($signature)) return false;
        $payloadParts = explode('.', $payload, 2);
        if (count($payloadParts) !== 2 || !ctype_digit($payloadParts[0]) || (int) $payloadParts[0] < $this->clock->now() || !hash_equals($sessionId, $payloadParts[1])) return false;
        return hash_equals(hash_hmac('sha256', $payload, $this->config->getString('session_secret'), true), $signature);
    }

    private function validUuid(string $value): bool
    {
        return (bool) preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $value);
    }
}

final class DtoValidator
{
    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function places(array $input): array
    {
        $this->keys($input, ['provider', 'query', 'limit', 'language', 'region', 'locationBias'], ['provider', 'query', 'limit']);
        $dto = ['provider' => $this->provider($input['provider']), 'query' => $this->text($input['query'], 1, 200, 'query'), 'limit' => $this->integer($input['limit'], 1, 20, 'limit')];
        if (isset($input['language'])) $dto['language'] = $this->pattern($input['language'], '/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/D', 16, 'language');
        if (isset($input['region'])) $dto['region'] = $this->pattern($input['region'], '/^[A-Za-z]{2}$/D', 2, 'region');
        if (isset($input['locationBias'])) {
            if (!is_array($input['locationBias']) || array_is_list($input['locationBias'])) $this->invalid('locationBias is invalid.');
            $this->keys($input['locationBias'], ['lat', 'lng', 'radiusMeters'], ['lat', 'lng', 'radiusMeters']);
            $dto['locationBias'] = $this->point([
                'lat' => $input['locationBias']['lat'],
                'lng' => $input['locationBias']['lng']
            ], 'locationBias') + [
                'radiusMeters' => $this->integer($input['locationBias']['radiusMeters'], 1, 50000, 'radiusMeters')
            ];
        }
        return $dto;
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function route(array $input): array
    {
        $this->keys($input, ['provider', 'origin', 'destination', 'travelMode'], ['provider', 'origin', 'destination', 'travelMode']);
        return ['provider' => $this->provider($input['provider']), 'origin' => $this->point($input['origin'], 'origin'), 'destination' => $this->point($input['destination'], 'destination'), 'travelMode' => $this->mode($input['travelMode'])];
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function matrix(array $input): array
    {
        $this->keys($input, ['provider', 'origins', 'destinations', 'travelMode'], ['provider', 'origins', 'destinations', 'travelMode']);
        if (!is_array($input['origins']) || !array_is_list($input['origins']) || !is_array($input['destinations']) || !array_is_list($input['destinations'])) $this->invalid('origins and destinations must be arrays.');
        if (count($input['origins']) < 1 || count($input['origins']) > 10 || count($input['destinations']) < 1 || count($input['destinations']) > 10 || count($input['origins']) * count($input['destinations']) > 25) $this->invalid('Matrix dimensions exceed the safe limit.');
        return ['provider' => $this->provider($input['provider']), 'origins' => array_map(fn ($point) => $this->point($point, 'origin'), $input['origins']), 'destinations' => array_map(fn ($point) => $this->point($point, 'destination'), $input['destinations']), 'travelMode' => $this->mode($input['travelMode'])];
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function staticMap(array $input): array
    {
        $this->keys($input, ['provider', 'points', 'width', 'height', 'drawPath'], ['provider', 'points', 'width', 'height', 'drawPath']);
        if (!is_array($input['points']) || !array_is_list($input['points']) || count($input['points']) < 1 || count($input['points']) > 50) $this->invalid('points must contain 1 to 50 coordinates.');
        if (!is_bool($input['drawPath'])) $this->invalid('drawPath must be a boolean.');
        return ['provider' => $this->provider($input['provider']), 'points' => array_map(fn ($point) => $this->point($point, 'point'), $input['points']), 'width' => $this->integer($input['width'], 320, 1280, 'width'), 'height' => $this->integer($input['height'], 200, 1280, 'height'), 'drawPath' => $input['drawPath']];
    }

    /** @param array<string, mixed> $input @param list<string> $allowed @param list<string> $required */
    private function keys(array $input, array $allowed, array $required): void
    {
        foreach (array_keys($input) as $key) if (!is_string($key) || !in_array($key, $allowed, true)) $this->invalid('Request contains an unknown field.');
        foreach ($required as $key) if (!array_key_exists($key, $input)) $this->invalid('Request is missing a required field.');
    }

    private function provider(mixed $value): string
    {
        if (!is_string($value) || !in_array($value, ['google', 'gaode', 'tianditu', 'azure'], true)) $this->invalid('provider is invalid.');
        return $value;
    }

    private function mode(mixed $value): string
    {
        if (!is_string($value) || !in_array($value, ['DRIVING', 'WALKING', 'BICYCLING', 'TRANSIT'], true)) $this->invalid('travelMode is invalid.');
        return $value;
    }

    /** @return array{lat: float, lng: float} */
    private function point(mixed $value, string $name): array
    {
        if (!is_array($value) || array_is_list($value)) $this->invalid($name . ' is invalid.');
        $this->keys($value, ['lat', 'lng'], ['lat', 'lng']);
        if (!is_float($value['lat']) && !is_int($value['lat']) || !is_float($value['lng']) && !is_int($value['lng'])) $this->invalid($name . ' is invalid.');
        $lat = (float) $value['lat']; $lng = (float) $value['lng'];
        if (!is_finite($lat) || !is_finite($lng) || $lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) $this->invalid($name . ' is invalid.');
        return ['lat' => $lat, 'lng' => $lng];
    }

    private function integer(mixed $value, int $min, int $max, string $name): int
    {
        if (!is_int($value) || $value < $min || $value > $max) $this->invalid($name . ' is invalid.');
        return $value;
    }

    private function text(mixed $value, int $min, int $max, string $name): string
    {
        if (!is_string($value)) $this->invalid($name . ' is invalid.');
        $text = trim($value);
        if (strlen($text) < $min || strlen($text) > $max || preg_match('/[\x00-\x1F\x7F]/', $text)) $this->invalid($name . ' is invalid.');
        return $text;
    }

    private function pattern(mixed $value, string $pattern, int $max, string $name): string
    {
        $text = $this->text($value, 1, $max, $name);
        if (!preg_match($pattern, $text)) $this->invalid($name . ' is invalid.');
        return $text;
    }

    private function invalid(string $message): never { throw new ApiException(422, 'INVALID_ARGUMENT', $message); }
}
