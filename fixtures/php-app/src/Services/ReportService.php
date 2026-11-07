<?php

namespace App\Services;

use App\Clients\RequestClientContract;

class ReportService
{
    public function __construct(private RequestClientContract $client)
    {
    }

    public function report(): string
    {
        return $this->client->send('/reports');
    }
}
