<?php

namespace Seqcall\Promo\Routes;

use Illuminate\Contracts\Routing\Registrar;
use Seqcall\Promo\Constants;
use Seqcall\Promo\Http\CodesController;

class ShopRouteBuilder
{
    /**
     * @param class-string $codes_controller
     */
    public function __construct(
        private Registrar $router,
        private ?string $codes_controller = CodesController::class,
    ) {
    }

    public function register(string $version = Constants::VERSION_V2): void
    {
        $this->router->group(['prefix' => $version], function ($router) {
            $router->group(['prefix' => 'codes'], function ($router) {
                $router->post('/{code}/apply', [$this->codes_controller, 'apply'])->name('promo.apply');
            });
        });
    }
}
