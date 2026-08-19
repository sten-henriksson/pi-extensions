from pathlib import Path

Path("app/records.py").write_text(
    '''def merge_records(records: list[dict]) -> list[dict]:
    by_id = {}
    for record in records:
        by_id[record["id"]] = record
    return list(by_id.values())
'''
)
Path("tests/test_records.py").write_text(
    '''import copy
import unittest
from app.records import merge_records


class RecordTests(unittest.TestCase):
    def test_merges_duplicate_ids_with_stable_order_and_tags(self):
        source = [
            {"id": "a", "name": "first", "tags": ["red", "blue"]},
            {"id": "b", "name": "second", "tags": ["green"]},
            {"id": "a", "name": "latest", "tags": ["blue", "gold"], "active": True},
        ]
        before = copy.deepcopy(source)
        self.assertEqual(
            merge_records(source),
            [
                {"id": "a", "name": "latest", "tags": ["red", "blue", "gold"], "active": True},
                {"id": "b", "name": "second", "tags": ["green"]},
            ],
        )
        self.assertEqual(source, before)

    def test_rejects_missing_or_empty_ids(self):
        for bad in [{}, {"id": ""}, {"id": 3}]:
            with self.assertRaises(ValueError):
                merge_records([bad])


if __name__ == "__main__":
    unittest.main()
'''
)
