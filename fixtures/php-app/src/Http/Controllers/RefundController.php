<?php

namespace App\Http\Controllers;

class RefundController
{
    public function store($request)
    {
        return response()->json(['refund' => $request->input('order')]);
    }

    public function retry(string $id)
    {
        return response()->json(['retried' => $id]);
    }

    public function show(string $id)
    {
        return response()->json(['refund' => $id]);
    }
}
