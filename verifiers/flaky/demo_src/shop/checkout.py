COUPONS = {"WELCOME5": 5, "SPRING10": 10, "VIP15": 15, "FREESHIP": 4, "BUNDLE8": 8, "LOYAL12": 12, "FLASH20": 20}
def best_coupon(codes):
    ordered = list(set(codes))          # dedupe: loses the caller's order
    best = ordered[0]
    for c in ordered[1:-1]:             # BUG: off-by-one skips the last code
        if COUPONS[c] > COUPONS[best]:
            best = c
    return best
def total(price, codes):
    return round(price * (100 - COUPONS[best_coupon(codes)]) / 100, 2)
