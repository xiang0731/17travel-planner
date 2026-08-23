<?php

declare(strict_types=1);

use TravelPlanner\Bff\Application;
use TravelPlanner\Bff\Authenticator;
use TravelPlanner\Bff\AzureMapsAdapter;
use TravelPlanner\Bff\Config;
use TravelPlanner\Bff\CurlUpstreamClient;
use TravelPlanner\Bff\GaodeMapsAdapter;
use TravelPlanner\Bff\GoogleMapsAdapter;
use TravelPlanner\Bff\JsonLogger;
use TravelPlanner\Bff\ProviderRegistry;
use TravelPlanner\Bff\StateStore;
use TravelPlanner\Bff\SystemClock;
use TravelPlanner\Bff\TiandituMapsAdapter;

require_once __DIR__ . '/src/Support.php';
require_once __DIR__ . '/src/Http.php';
require_once __DIR__ . '/src/StateStore.php';
require_once __DIR__ . '/src/Provider.php';
require_once __DIR__ . '/src/Security.php';
require_once __DIR__ . '/src/Application.php';

$config = Config::fromEnvironment();
$clock = new SystemClock();
$client = new CurlUpstreamClient($config);
$registry = new ProviderRegistry([
    new GoogleMapsAdapter($client, $config->providerKey('google')),
    new GaodeMapsAdapter($client, $config->providerKey('gaode')),
    new TiandituMapsAdapter($client, $config->providerKey('tianditu')),
    new AzureMapsAdapter($client, $config->providerKey('azure')),
]);

return new Application(
    $config,
    $clock,
    new JsonLogger(environment: $config->getString('environment')),
    new StateStore($config->getString('db_path')),
    new Authenticator($config, $clock),
    $registry,
);
