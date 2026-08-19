from pathlib import Path

Path("app/retry.py").write_text(
    '''def retry(operation, attempts: int = 3):
    return operation()
'''
)
Path("tests/test_retry.py").write_text(
    '''import unittest
from app.retry import retry


class RetryTests(unittest.TestCase):
    def test_returns_after_a_later_success(self):
        calls = []
        def operation():
            calls.append(1)
            if len(calls) < 3:
                raise RuntimeError("temporary")
            return "ok"
        self.assertEqual(retry(operation, attempts=3), "ok")
        self.assertEqual(len(calls), 3)

    def test_reraises_last_error_after_exact_attempt_count(self):
        calls = []
        def operation():
            calls.append(1)
            raise LookupError(str(len(calls)))
        with self.assertRaisesRegex(LookupError, "2"):
            retry(operation, attempts=2)
        self.assertEqual(len(calls), 2)

    def test_rejects_non_positive_attempts(self):
        with self.assertRaises(ValueError):
            retry(lambda: None, attempts=0)


if __name__ == "__main__":
    unittest.main()
'''
)
