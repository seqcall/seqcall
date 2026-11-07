<?php

function money_format(int $cents): string
{
    return number_format($cents / 100, 2);
}
