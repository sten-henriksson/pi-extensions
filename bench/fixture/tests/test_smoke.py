import unittest


class FixtureSmokeTest(unittest.TestCase):
    def test_fixture_loads(self):
        import app
        self.assertIsNotNone(app)


if __name__ == "__main__":
    unittest.main()
