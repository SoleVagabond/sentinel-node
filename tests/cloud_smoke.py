"""Validate packaged AWS SDK and S3 contracts with a stubbed client, never AWS."""
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'work/lambda-staging'))
import boto3
from botocore.exceptions import ClientError
from botocore.stub import Stubber
import monitor


class CloudPackageTests(unittest.TestCase):
    def setUp(self):
        client = boto3.client('s3', region_name='us-east-1', aws_access_key_id='stub-only', aws_secret_access_key='stub-only')
        self.stubber = Stubber(client)
        with patch('boto3.client', return_value=client):
            self.store = monitor.S3Store('sentinel-test')
        self.stubber.activate()
        self.addCleanup(self.stubber.deactivate)

    def test_existing_snapshot_is_parsed(self):
        self.stubber.add_response('get_object', {'Body': io.BytesIO(b'{"schema_version": 1}')}, {'Bucket': 'sentinel-test', 'Key': 'status_data.json'})
        self.assertEqual(self.store.read('status_data.json'), {'schema_version': 1})
        self.stubber.assert_no_pending_responses()

    def test_missing_snapshot_starts_empty(self):
        self.stubber.add_client_error('get_object', service_error_code='NoSuchKey', http_status_code=404, expected_params={'Bucket': 'sentinel-test', 'Key': 'status_data.json'})
        self.assertEqual(self.store.read('status_data.json'), {})
        self.stubber.assert_no_pending_responses()

    def test_access_denied_is_not_treated_as_empty_history(self):
        self.stubber.add_client_error('get_object', service_error_code='AccessDenied', http_status_code=403, expected_params={'Bucket': 'sentinel-test', 'Key': 'history.json'})
        with self.assertRaises(ClientError): self.store.read('history.json')
        self.stubber.assert_no_pending_responses()

    def test_write_uses_json_and_disables_stale_caching(self):
        self.stubber.add_response('put_object', {}, {'Bucket': 'sentinel-test', 'Key': 'status_data.json', 'Body': b'{"schema_version": 1}', 'ContentType': 'application/json', 'CacheControl': 'no-store'})
        self.store.write('status_data.json', {'schema_version': 1})
        self.stubber.assert_no_pending_responses()


if __name__ == '__main__':
    unittest.main(verbosity=2)
