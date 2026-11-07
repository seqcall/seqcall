<?php

namespace App\Services;

use App\Domain\Order;
use App\Domain\OrderStatus;
use App\Domain\Pricing;
use App\Notifications\EmailNotifier;
use App\Payments\PaymentFailed;
use App\Payments\PaymentGateway;
use App\Repositories\OrderRepositoryContract;
use Illuminate\Support\Facades\Log;

final class OrderService
{
    public function __construct(
        private OrderRepositoryContract $repository,
        private PaymentGateway $payments,
        private EmailNotifier $notifier,
    ) {
    }

    /**
     * @param array<int, array{sku: string, qty: int}> $items
     */
    public function placeOrder(int $userId, array $items): Order
    {
        $user = $this->repository->findUser($userId);
        if ($user === null) {
            throw new \InvalidArgumentException('unknown user');
        }
        $total = 0;
        foreach ($items as $item) {
            $total += Pricing::priceOf($item['sku'], $item['qty']);
        }
        if ($total > 100) {
            $this->notifier->notify($user, 'big order');
        } elseif ($total === 0) {
            return Order::empty();
        } else {
            Log::info('small order');
        }
        try {
            $receipt = $this->payments->charge($userId, $total);
        } catch (PaymentFailed $e) {
            Log::error($e->getMessage());
            throw $e;
        }
        $order = new Order($userId, $total, $receipt);
        collect($items)->each(fn ($item) => $this->repository->reserve($item['sku']));
        $status = OrderStatus::from('placed');
        return $this->repository->save($order->withStatus($status));
    }

    /** FR-1.17 a failed charge is logged and swallowed. */
    public function retryCharge(int $userId, int $total): void
    {
        try {
            $this->payments->charge($userId, $total);
        } catch (PaymentFailed $e) {
            Log::warning('charge failed');
        }
    }
}
