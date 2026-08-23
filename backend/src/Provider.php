<?php

declare(strict_types=1);

namespace TravelPlanner\Bff;

interface ProviderAdapter
{
    public function id(): string;
    public function isConfigured(): bool;

    /** @param array<string, mixed> $dto @return array<string, mixed> */
    public function searchPlaces(array $dto): array;

    /** @param array<string, mixed> $dto @return array<string, mixed> */
    public function route(array $dto): array;

    /** @param array<string, mixed> $dto @return array<string, mixed> */
    public function routeMatrix(array $dto): array;

    /** @param array<string, mixed> $dto @return array{content_type: string, body: string} */
    public function staticMap(array $dto): array;
}

final class ProviderRegistry
{
    /** @var array<string, ProviderAdapter> */
    private array $adapters = [];

    /** @param iterable<ProviderAdapter> $adapters */
    public function __construct(iterable $adapters)
    {
        foreach ($adapters as $adapter) {
            $this->adapters[$adapter->id()] = $adapter;
        }
    }

    public function get(string $provider): ProviderAdapter
    {
        if (!isset($this->adapters[$provider])) {
            throw new ApiException(422, 'PROVIDER_UNAVAILABLE', 'Requested map provider is unavailable.');
        }
        return $this->adapters[$provider];
    }
}

final class UpstreamResponse
{
    /** @param array<string, string> $headers */
    public function __construct(
        public readonly int $status,
        public readonly string $body,
        public readonly string $contentType,
        public readonly array $headers = [],
    ) {
    }

    /** @return array<string, mixed> */
    public function json(): array
    {
        try {
            $data = json_decode($this->body, true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new ApiException(502, 'UPSTREAM_INVALID_RESPONSE', 'Map provider returned invalid data.', countsAsProviderFailure: true);
        }
        if (!is_array($data)) {
            throw new ApiException(502, 'UPSTREAM_INVALID_RESPONSE', 'Map provider returned invalid data.', countsAsProviderFailure: true);
        }
        return $data;
    }
}

interface UpstreamClient
{
    /** @param array<string, string> $headers */
    public function request(string $method, string $url, array $headers = [], ?string $body = null): UpstreamResponse;
}

final class CurlUpstreamClient implements UpstreamClient
{
    public function __construct(private readonly Config $config)
    {
    }

    public function request(string $method, string $url, array $headers = [], ?string $body = null): UpstreamResponse
    {
        $parts = parse_url($url);
        $allowedHosts = [
            'places.googleapis.com', 'routes.googleapis.com', 'maps.googleapis.com',
            'restapi.amap.com', 'api.tianditu.gov.cn', 'atlas.microsoft.com',
        ];
        if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || !in_array($parts['host'] ?? '', $allowedHosts, true)) {
            throw new ApiException(500, 'UPSTREAM_POLICY_VIOLATION', 'Configured provider endpoint is not allowed.');
        }

        $handle = curl_init($url);
        if ($handle === false) throw new \RuntimeException('Unable to initialize HTTP client.');
        $responseHeaders = [];
        $responseBody = '';
        curl_setopt_array($handle, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_MAXREDIRS => 0,
            CURLOPT_CONNECTTIMEOUT_MS => $this->config->getInt('upstream_connect_timeout_ms'),
            CURLOPT_TIMEOUT_MS => $this->config->getInt('upstream_timeout_ms'),
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_HTTPHEADER => array_map(static fn (string $key, string $value): string => $key . ': ' . $value, array_keys($headers), $headers),
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$responseHeaders): int {
                $position = strpos($line, ':');
                if ($position !== false) {
                    $responseHeaders[strtolower(trim(substr($line, 0, $position)))] = trim(substr($line, $position + 1));
                }
                return strlen($line);
            },
            CURLOPT_WRITEFUNCTION => function ($curl, string $chunk) use (&$responseBody): int {
                $responseBody = ($responseBody ?? '') . $chunk;
                if (strlen($responseBody) > $this->config->getInt('upstream_max_response_bytes')) return 0;
                return strlen($chunk);
            },
        ]);
        $ok = curl_exec($handle);
        $errorNumber = curl_errno($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $contentType = strtolower(trim(explode(';', (string) curl_getinfo($handle, CURLINFO_CONTENT_TYPE))[0]));
        curl_close($handle);

        if ($ok === false || $errorNumber !== 0) {
            $timeout = in_array($errorNumber, [CURLE_OPERATION_TIMEDOUT], true);
            throw new ApiException($timeout ? 504 : 502, $timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', $timeout ? 'Map provider timed out.' : 'Map provider is unavailable.', countsAsProviderFailure: true);
        }
        if ($status < 200 || $status >= 300) {
            if ($status === 429) throw new ApiException(429, 'PROVIDER_QUOTA_EXCEEDED', 'Map provider quota is exhausted.');
            if ($status === 401 || $status === 403) throw new ApiException(502, 'PROVIDER_KEY_INVALID', 'Map provider key was rejected.');
            throw new ApiException(502, 'UPSTREAM_REJECTED', 'Map provider rejected the request.', countsAsProviderFailure: $status >= 500);
        }
        return new UpstreamResponse($status, $responseBody, $contentType, $responseHeaders);
    }
}

abstract class AbstractAdapter implements ProviderAdapter
{
    public function __construct(protected readonly UpstreamClient $client, protected readonly string $key)
    {
    }

    public function isConfigured(): bool { return $this->key !== ''; }

    protected function requireKey(): string
    {
        if ($this->key === '') throw new ApiException(503, 'PROVIDER_NOT_CONFIGURED', 'Map provider is not configured.');
        return $this->key;
    }

    /** @param array<string, scalar> $query */
    protected function url(string $origin, string $path, array $query): string
    {
        return $origin . $path . '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
    }

    protected function unsupported(string $capability): never
    {
        throw new ApiException(422, 'CAPABILITY_UNAVAILABLE', $capability . ' is unavailable for this provider.');
    }

    protected function durationSeconds(mixed $duration): int
    {
        if (is_numeric($duration)) return max(0, (int) round((float) $duration));
        if (is_string($duration) && preg_match('/^([0-9]+(?:\.[0-9]+)?)s$/D', $duration, $match)) return (int) round((float) $match[1]);
        return 0;
    }

    /** @param array<string, mixed> $data */
    protected function rejectProviderPayload(array $data): never
    {
        $providerCode = strtoupper((string) ($data['infocode'] ?? $data['code'] ?? $data['statusCode'] ?? ''));
        $providerMessage = strtolower((string) ($data['info'] ?? $data['message'] ?? $data['msg'] ?? $data['error']['message'] ?? ''));
        $keyCodes = ['10001', '10002', '10008', '10009', '10012', 'INVALID_KEY', 'UNAUTHORIZED'];
        $quotaCodes = ['10003', '10004', '10005', '10014', '10019', '10020', '10021', '429', 'RESOURCE_EXHAUSTED'];
        if (in_array($providerCode, $keyCodes, true) || preg_match('/(?:invalid|illegal|missing)[ _-]?(?:api[ _-]?)?key|key.*(?:invalid|expired)|签名|密钥.*(?:无效|错误)/i', $providerMessage)) {
            throw new ApiException(502, 'PROVIDER_KEY_INVALID', 'Map provider key was rejected.');
        }
        if (in_array($providerCode, $quotaCodes, true) || preg_match('/quota|rate.?limit|too (?:many|frequent)|配额|超限|访问过于频繁/i', $providerMessage)) {
            throw new ApiException(429, 'PROVIDER_QUOTA_EXCEEDED', 'Map provider quota is exhausted.');
        }
        throw new ApiException(502, 'UPSTREAM_REJECTED', 'Map provider rejected the request.');
    }
}

final class GoogleMapsAdapter extends AbstractAdapter
{
    public function id(): string { return 'google'; }

    public function searchPlaces(array $dto): array
    {
        $body = ['textQuery' => $dto['query'], 'maxResultCount' => $dto['limit']];
        if (isset($dto['language'])) $body['languageCode'] = $dto['language'];
        if (isset($dto['region'])) $body['regionCode'] = $dto['region'];
        if (isset($dto['locationBias'])) {
            $body['locationBias'] = ['circle' => [
                'center' => ['latitude' => $dto['locationBias']['lat'], 'longitude' => $dto['locationBias']['lng']],
                'radius' => $dto['locationBias']['radiusMeters'],
            ]];
        }
        $response = $this->client->request('POST', 'https://places.googleapis.com/v1/places:searchText', [
            'Content-Type' => 'application/json',
            'X-Goog-Api-Key' => $this->requireKey(),
            'X-Goog-FieldMask' => 'places.id,places.displayName,places.formattedAddress,places.location',
        ], json_encode($body, JSON_THROW_ON_ERROR));
        $data = $response->json();
        $places = [];
        foreach (array_slice(is_array($data['places'] ?? null) ? $data['places'] : [], 0, $dto['limit']) as $place) {
            if (!is_array($place)) continue;
            $lat = $place['location']['latitude'] ?? null;
            $lng = $place['location']['longitude'] ?? null;
            if (!is_numeric($lat) || !is_numeric($lng)) continue;
            $places[] = ['id' => substr((string) ($place['id'] ?? ''), 0, 256), 'name' => substr((string) ($place['displayName']['text'] ?? ''), 0, 800), 'address' => substr((string) ($place['formattedAddress'] ?? ''), 0, 2000), 'location' => ['lat' => (float) $lat, 'lng' => (float) $lng]];
        }
        return ['provider' => $this->id(), 'places' => $places];
    }

    public function route(array $dto): array
    {
        $waypoint = static fn (array $point): array => ['location' => ['latLng' => ['latitude' => $point['lat'], 'longitude' => $point['lng']]]];
        $body = ['origin' => $waypoint($dto['origin']), 'destination' => $waypoint($dto['destination']), 'travelMode' => ['DRIVING' => 'DRIVE', 'WALKING' => 'WALK', 'BICYCLING' => 'BICYCLE', 'TRANSIT' => 'TRANSIT'][$dto['travelMode']], 'polylineEncoding' => 'GEO_JSON_LINESTRING'];
        $response = $this->client->request('POST', 'https://routes.googleapis.com/directions/v2:computeRoutes', ['Content-Type' => 'application/json', 'X-Goog-Api-Key' => $this->requireKey(), 'X-Goog-FieldMask' => 'routes.distanceMeters,routes.duration,routes.polyline.geoJsonLinestring'], json_encode($body, JSON_THROW_ON_ERROR));
        $route = $response->json()['routes'][0] ?? null;
        if (!is_array($route)) throw new ApiException(502, 'UPSTREAM_INVALID_RESPONSE', 'Map provider returned no route.', countsAsProviderFailure: true);
        $points = [];
        foreach (($route['polyline']['geoJsonLinestring']['coordinates'] ?? []) as $coordinate) if (is_array($coordinate) && is_numeric($coordinate[0] ?? null) && is_numeric($coordinate[1] ?? null)) $points[] = ['lat' => (float) $coordinate[1], 'lng' => (float) $coordinate[0]];
        return ['provider' => $this->id(), 'distanceMeters' => (int) ($route['distanceMeters'] ?? 0), 'durationSeconds' => $this->durationSeconds($route['duration'] ?? ''), 'polyline' => array_slice($points, 0, 10000)];
    }

    public function routeMatrix(array $dto): array
    {
        $entry = static fn (array $point): array => ['waypoint' => ['location' => ['latLng' => ['latitude' => $point['lat'], 'longitude' => $point['lng']]]]];
        $body = ['origins' => array_map($entry, $dto['origins']), 'destinations' => array_map($entry, $dto['destinations']), 'travelMode' => ['DRIVING' => 'DRIVE', 'WALKING' => 'WALK', 'BICYCLING' => 'BICYCLE', 'TRANSIT' => 'TRANSIT'][$dto['travelMode']]];
        $response = $this->client->request('POST', 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', ['Content-Type' => 'application/json', 'X-Goog-Api-Key' => $this->requireKey(), 'X-Goog-FieldMask' => 'originIndex,destinationIndex,status,condition,distanceMeters,duration'], json_encode($body, JSON_THROW_ON_ERROR));
        $rows = array_fill(0, count($dto['origins']), array_fill(0, count($dto['destinations']), ['status' => 'NO_ROUTE', 'distanceMeters' => null, 'durationSeconds' => null]));
        foreach (preg_split('/\R/', trim($response->body)) ?: [] as $line) {
            if ($line === '') continue;
            $element = json_decode($line, true);
            if (!is_array($element)) continue;
            $origin = (int) ($element['originIndex'] ?? -1); $destination = (int) ($element['destinationIndex'] ?? -1);
            if (!isset($rows[$origin][$destination])) continue;
            $rows[$origin][$destination] = ['status' => isset($element['distanceMeters']) ? 'OK' : 'NO_ROUTE', 'distanceMeters' => isset($element['distanceMeters']) ? (int) $element['distanceMeters'] : null, 'durationSeconds' => isset($element['duration']) ? $this->durationSeconds($element['duration']) : null];
        }
        return ['provider' => $this->id(), 'matrix' => $rows];
    }

    public function staticMap(array $dto): array
    {
        $markers = implode('|', array_map(static fn (array $point): string => $point['lat'] . ',' . $point['lng'], $dto['points']));
        $query = ['size' => $dto['width'] . 'x' . $dto['height'], 'scale' => 1, 'maptype' => 'roadmap', 'markers' => 'color:red|' . $markers, 'key' => $this->requireKey()];
        if ($dto['drawPath'] && count($dto['points']) > 1) $query['path'] = 'color:0x3367d6ff|weight:4|' . $markers;
        $response = $this->client->request('GET', $this->url('https://maps.googleapis.com', '/maps/api/staticmap', $query));
        if (!in_array($response->contentType, ['image/png', 'image/jpeg'], true)) throw new ApiException(502, 'UPSTREAM_INVALID_RESPONSE', 'Map provider returned invalid image data.', countsAsProviderFailure: true);
        return ['content_type' => $response->contentType, 'body' => $response->body];
    }
}

final class GaodeMapsAdapter extends AbstractAdapter
{
    public function id(): string { return 'gaode'; }

    public function searchPlaces(array $dto): array
    {
        $query = ['key' => $this->requireKey(), 'keywords' => $dto['query'], 'offset' => $dto['limit'], 'page' => 1, 'extensions' => 'base'];
        if (isset($dto['locationBias'])) {
            $query['location'] = $this->coordinate($dto['locationBias']);
            $query['radius'] = $dto['locationBias']['radiusMeters'];
            $query['sortrule'] = 'distance';
        }
        $response = $this->client->request('GET', $this->url('https://restapi.amap.com', '/v3/place/text', $query));
        $data = $response->json();
        if (($data['status'] ?? '0') !== '1') $this->rejectProviderPayload($data);
        $places = [];
        foreach (array_slice(is_array($data['pois'] ?? null) ? $data['pois'] : [], 0, $dto['limit']) as $poi) {
            if (!is_array($poi) || !is_string($poi['location'] ?? null)) continue;
            $coordinate = array_map('floatval', explode(',', $poi['location']));
            if (count($coordinate) !== 2) continue;
            $addressParts = [$poi['pname'] ?? '', $poi['cityname'] ?? '', $poi['adname'] ?? '', $poi['address'] ?? ''];
            $places[] = ['id' => substr((string) ($poi['id'] ?? ''), 0, 256), 'name' => substr((string) ($poi['name'] ?? ''), 0, 800), 'address' => substr(implode('', array_filter($addressParts, 'is_string')), 0, 2000), 'location' => ['lat' => $coordinate[1], 'lng' => $coordinate[0]]];
        }
        return ['provider' => $this->id(), 'places' => $places];
    }

    public function route(array $dto): array
    {
        $modePath = ['DRIVING' => '/v5/direction/driving', 'WALKING' => '/v5/direction/walking', 'BICYCLING' => '/v5/direction/bicycling'][$dto['travelMode']] ?? null;
        if ($modePath === null) $this->unsupported('Requested travel mode');
        $response = $this->client->request('GET', $this->url('https://restapi.amap.com', $modePath, ['key' => $this->requireKey(), 'origin' => $this->coordinate($dto['origin']), 'destination' => $this->coordinate($dto['destination']), 'show_fields' => 'cost,polyline']));
        $data = $response->json();
        $route = $data['route']['paths'][0] ?? null;
        if (($data['status'] ?? '0') !== '1' || !is_array($route)) throw new ApiException(502, 'UPSTREAM_INVALID_RESPONSE', 'Map provider returned no route.', countsAsProviderFailure: true);
        $points = [];
        foreach (($route['steps'] ?? []) as $step) {
            if (!is_array($step) || !is_string($step['polyline'] ?? null)) continue;
            foreach (explode(';', $step['polyline']) as $pair) {
                $coordinate = array_map('floatval', explode(',', $pair));
                if (count($coordinate) === 2) $points[] = ['lat' => $coordinate[1], 'lng' => $coordinate[0]];
            }
        }
        return ['provider' => $this->id(), 'distanceMeters' => (int) ($route['distance'] ?? 0), 'durationSeconds' => (int) ($route['cost']['duration'] ?? $route['duration'] ?? 0), 'polyline' => array_slice($points, 0, 10000)];
    }

    public function routeMatrix(array $dto): array
    {
        $matrix = [];
        foreach ($dto['origins'] as $origin) {
            $row = [];
            foreach ($dto['destinations'] as $destination) {
                try {
                    $route = $this->route(['origin' => $origin, 'destination' => $destination, 'travelMode' => $dto['travelMode']]);
                    $row[] = ['status' => 'OK', 'distanceMeters' => $route['distanceMeters'], 'durationSeconds' => $route['durationSeconds']];
                } catch (ApiException $error) {
                    if ($error->errorCode === 'UPSTREAM_TIMEOUT') throw $error;
                    $row[] = ['status' => 'NO_ROUTE', 'distanceMeters' => null, 'durationSeconds' => null];
                }
            }
            $matrix[] = $row;
        }
        return ['provider' => $this->id(), 'matrix' => $matrix];
    }

    public function staticMap(array $dto): array { $this->unsupported('Static maps'); }

    /** @param array{lat: float, lng: float} $point */
    private function coordinate(array $point): string { return sprintf('%.6F,%.6F', $point['lng'], $point['lat']); }
}

final class TiandituMapsAdapter extends AbstractAdapter
{
    public function id(): string { return 'tianditu'; }

    public function searchPlaces(array $dto): array
    {
        $mapBound = '-180,-90,180,90';
        if (isset($dto['locationBias'])) {
            $latDelta = $dto['locationBias']['radiusMeters'] / 111320;
            $lngScale = max(0.1, cos(deg2rad($dto['locationBias']['lat'])));
            $lngDelta = $dto['locationBias']['radiusMeters'] / (111320 * $lngScale);
            $mapBound = implode(',', [
                max(-180, $dto['locationBias']['lng'] - $lngDelta),
                max(-90, $dto['locationBias']['lat'] - $latDelta),
                min(180, $dto['locationBias']['lng'] + $lngDelta),
                min(90, $dto['locationBias']['lat'] + $latDelta),
            ]);
        }
        $post = json_encode(['keyWord' => $dto['query'], 'level' => 12, 'mapBound' => $mapBound, 'queryType' => 1, 'count' => $dto['limit'], 'start' => 0], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $response = $this->client->request('GET', $this->url('https://api.tianditu.gov.cn', '/v2/search', ['postStr' => $post, 'type' => 'query', 'tk' => $this->requireKey()]));
        $data = $response->json();
        if (isset($data['error']) || (isset($data['code']) && (string) $data['code'] !== '0' && !isset($data['pois']))) $this->rejectProviderPayload($data);
        $places = [];
        foreach (array_slice(is_array($data['pois'] ?? null) ? $data['pois'] : [], 0, $dto['limit']) as $poi) {
            if (!is_array($poi) || !is_string($poi['lonlat'] ?? null)) continue;
            $coordinate = preg_split('/[\s,]+/', trim($poi['lonlat']));
            if (!is_array($coordinate) || count($coordinate) < 2 || !is_numeric($coordinate[0]) || !is_numeric($coordinate[1])) continue;
            $places[] = ['id' => substr((string) ($poi['hotPointID'] ?? ''), 0, 256), 'name' => substr((string) ($poi['name'] ?? ''), 0, 800), 'address' => substr((string) ($poi['address'] ?? ''), 0, 2000), 'location' => ['lat' => (float) $coordinate[1], 'lng' => (float) $coordinate[0]]];
        }
        return ['provider' => $this->id(), 'places' => $places];
    }

    public function route(array $dto): array
    {
        if ($dto['travelMode'] !== 'DRIVING') $this->unsupported('Requested travel mode');
        $post = json_encode(['orig' => $this->coordinate($dto['origin']), 'dest' => $this->coordinate($dto['destination']), 'style' => '0'], JSON_THROW_ON_ERROR);
        $response = $this->client->request('GET', $this->url('https://api.tianditu.gov.cn', '/drive', ['postStr' => $post, 'type' => 'search', 'tk' => $this->requireKey()]));
        $data = $response->json();
        $routes = $data['result']['routes'] ?? $data['routes'] ?? [];
        $route = is_array($routes) ? ($routes[0] ?? null) : null;
        if (!is_array($route)) throw new ApiException(502, 'UPSTREAM_INVALID_RESPONSE', 'Map provider returned no route.', countsAsProviderFailure: true);
        $polyline = (string) ($route['routelatlon'] ?? $route['line'] ?? '');
        $points = [];
        foreach (preg_split('/[;\s]+/', trim($polyline)) ?: [] as $pair) {
            $coordinate = array_map('floatval', explode(',', $pair));
            if (count($coordinate) === 2) $points[] = ['lat' => $coordinate[1], 'lng' => $coordinate[0]];
        }
        return ['provider' => $this->id(), 'distanceMeters' => (int) ($route['distance'] ?? 0), 'durationSeconds' => (int) ($route['duration'] ?? 0), 'polyline' => array_slice($points, 0, 10000)];
    }

    public function routeMatrix(array $dto): array
    {
        $matrix = [];
        foreach ($dto['origins'] as $origin) {
            $row = [];
            foreach ($dto['destinations'] as $destination) {
                try {
                    $route = $this->route(['origin' => $origin, 'destination' => $destination, 'travelMode' => $dto['travelMode']]);
                    $row[] = ['status' => 'OK', 'distanceMeters' => $route['distanceMeters'], 'durationSeconds' => $route['durationSeconds']];
                } catch (ApiException $error) {
                    if ($error->errorCode === 'UPSTREAM_TIMEOUT') throw $error;
                    $row[] = ['status' => 'NO_ROUTE', 'distanceMeters' => null, 'durationSeconds' => null];
                }
            }
            $matrix[] = $row;
        }
        return ['provider' => $this->id(), 'matrix' => $matrix];
    }

    public function staticMap(array $dto): array { $this->unsupported('Static maps'); }
    /** @param array{lat: float, lng: float} $point */
    private function coordinate(array $point): string { return sprintf('%.6F,%.6F', $point['lng'], $point['lat']); }
}

final class AzureMapsAdapter extends AbstractAdapter
{
    public function id(): string { return 'azure'; }
    public function searchPlaces(array $dto): array { $this->unsupported('Place search'); }
    public function route(array $dto): array { $this->unsupported('Routes'); }
    public function routeMatrix(array $dto): array { $this->unsupported('Route matrix'); }

    public function staticMap(array $dto): array
    {
        $points = implode('|', array_map(static fn (array $point): string => $point['lng'] . ' ' . $point['lat'], $dto['points']));
        $query = ['api-version' => '2024-04-01', 'width' => $dto['width'], 'height' => $dto['height'], 'pins' => 'default||' . $points];
        if ($dto['drawPath'] && count($dto['points']) > 1) $query['path'] = 'lc3367D6|lw4||' . $points;
        $response = $this->client->request('GET', $this->url('https://atlas.microsoft.com', '/map/static', $query), ['subscription-key' => $this->requireKey()]);
        if (!in_array($response->contentType, ['image/png', 'image/jpeg'], true)) throw new ApiException(502, 'UPSTREAM_INVALID_RESPONSE', 'Map provider returned invalid image data.', countsAsProviderFailure: true);
        return ['content_type' => $response->contentType, 'body' => $response->body];
    }
}
