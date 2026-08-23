<?php

declare(strict_types=1);

namespace TravelPlanner\Bff;

use JsonException;

final class Request
{
    /** @param array<string, string> $headers @param array<string, string> $cookies */
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $headers = [],
        public readonly string $body = '',
        public readonly array $cookies = [],
    ) {
    }

    public function header(string $name): string
    {
        foreach ($this->headers as $key => $value) {
            if (strcasecmp($key, $name) === 0) {
                return trim($value);
            }
        }
        return '';
    }

    /** @return array<string, mixed> */
    public function json(int $maxBytes): array
    {
        if (strlen($this->body) > $maxBytes) {
            throw new ApiException(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
        }
        $contentType = strtolower(explode(';', $this->header('Content-Type'))[0]);
        if ($contentType !== 'application/json') {
            throw new ApiException(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
        }
        try {
            $decoded = json_decode($this->body, true, 32, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new ApiException(400, 'INVALID_JSON', 'Request body must be valid JSON.');
        }
        if (!is_array($decoded) || array_is_list($decoded)) {
            throw new ApiException(400, 'INVALID_JSON', 'Request body must be a JSON object.');
        }
        return $decoded;
    }

    public static function fromGlobals(): self
    {
        $headers = function_exists('getallheaders') ? getallheaders() : [];
        if (!is_array($headers)) {
            $headers = [];
        }
        return new self(
            strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')),
            (string) (parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/'),
            array_map('strval', $headers),
            (string) file_get_contents('php://input'),
            array_map('strval', $_COOKIE),
        );
    }
}

final class Response
{
    /** @param array<string, string> $headers */
    public function __construct(
        public readonly int $status,
        public readonly string $body = '',
        public readonly array $headers = [],
    ) {
    }

    /** @param array<string, mixed> $value @param array<string, string> $headers */
    public static function json(int $status, array $value, array $headers = []): self
    {
        $body = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        return new self($status, $body, array_merge([
            'Content-Type' => 'application/json; charset=utf-8',
            'Cache-Control' => 'no-store',
            'X-Content-Type-Options' => 'nosniff',
        ], $headers));
    }

    public function emit(): never
    {
        http_response_code($this->status);
        foreach ($this->headers as $name => $value) {
            header($name . ': ' . $value, true);
        }
        echo $this->body;
        exit;
    }
}

final class ApiException extends \RuntimeException
{
    /** @param array<string, string|int> $responseHeaders */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly array $responseHeaders = [],
        public readonly bool $countsAsProviderFailure = false,
    ) {
        parent::__construct($message);
    }
}

final class Actor
{
    public function __construct(
        public readonly string $type,
        public readonly string $subject,
        public readonly string $tenant,
    ) {
    }

    public function scope(): string
    {
        return $this->type . ':' . $this->tenant . ':' . $this->subject;
    }
}
