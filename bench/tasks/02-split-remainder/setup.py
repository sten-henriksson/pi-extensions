from pathlib import Path

Path("app/money.py").write_text(
    '''def split_evenly(total_cents: int, people: int) -> list[int]:
    return [total_cents // people] * people
'''
)
Path("tests/test_money.py").write_text(
    '''import unittest
from app.money import split_evenly


class MoneyTests(unittest.TestCase):
    def test_remainder_is_preserved_and_front_loaded(self):
        self.assertEqual(split_evenly(10, 3), [4, 3, 3])
        self.assertEqual(split_evenly(2, 5), [1, 1, 0, 0, 0])
        self.assertEqual(sum(split_evenly(101, 8)), 101)

    def test_invalid_inputs(self):
        for total, people in [(-1, 2), (1, 0), (1, -1)]:
            with self.assertRaises(ValueError):
                split_evenly(total, people)


if __name__ == "__main__":
    unittest.main()
'''
)
