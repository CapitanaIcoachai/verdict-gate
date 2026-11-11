import unittest
from shop.checkout import total
class TestTotal(unittest.TestCase):
    def test_total(self):
        self.assertEqual(total(100.0, ["WELCOME5","SPRING10","VIP15","FREESHIP","BUNDLE8","LOYAL12","FLASH20"]), 80.0)
