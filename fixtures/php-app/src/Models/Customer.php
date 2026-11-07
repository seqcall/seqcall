<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Customer extends Model
{
    public function account()
    {
        return $this->hasOne(Account::class);
    }

    public function notes()
    {
        return $this->hasMany(Note::class);
    }

    public function reward(int $points): void
    {
        $account = $this->account;
        $account->credit($points);
        $note = new Note();
        $note->save();
    }
}
