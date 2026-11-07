<?php

namespace Seqcall\Promo\Routes;

use Illuminate\Contracts\Routing\Registrar;
use Seqcall\Promo\Constants;

/** A package whose routes the project mounts in its own route files (FR-18.11 B). */
class PromoRegistrar
{
    public function __construct(private readonly Registrar $router)
    {
    }

    public function registerShopRoutes(): void
    {
        (new ShopRouteBuilder($this->router))->register(Constants::VERSION_V3);
    }

    /** Never mounted by the project: not an entry point of it. */
    public function registerStaffRoutes(): void
    {
        $this->router->get('staff/codes', [\Seqcall\Promo\Http\CodesController::class, 'index']);
    }
}
