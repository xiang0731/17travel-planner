<?php

declare(strict_types=1);

use TravelPlanner\Bff\Request;

$application = require dirname(__DIR__) . '/bootstrap.php';
$application->handle(Request::fromGlobals())->emit();
