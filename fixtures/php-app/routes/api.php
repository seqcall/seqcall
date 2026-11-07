<?php

use App\Http\Controllers\OrderController;
use Seqcall\Promo\Routes\PromoRegistrar;

Route::post('orders', [OrderController::class, 'store'])->name('orders.store');

Route::group(['prefix' => 'admin', 'namespace' => 'Admin'], function () {
    Route::get('stats/{day}', 'StatsController@show')->middleware('auth');
    Route::match(['get', 'post'], 'refresh', 'StatsController@refresh');
});

Route::apiResource('products', \App\Http\Controllers\ProductController::class);
Route::get('ping', fn () => 'pong');
Route::get('reference-only')->name('ref');
Route::get('gone', 'MissingController@index');

// a first-party package's routes mounted under the project's own prefix (FR-18.11 B)
Route::group(['prefix' => 'promo'], function () {
    app(PromoRegistrar::class)->registerShopRoutes();
});
