#!/usr/bin/env python3
"""
Python script that replicates the RadicalPilot execute button functionality.
This script performs the same API calls as the JavaScript execute button.
"""

import requests
import json
import time
from datetime import datetime
from typing import List, Dict, Any


class RadicalPilotClient:
    def __init__(self, base_url: str = "https://95.217.193.116:8000"):
        self.base_url = base_url
        self.cid = None
        self.tids = []
        self.session = requests.Session()
        self.session.headers.update({
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        })

    def log(self, message: str) -> None:
        """Print timestamped log message"""
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"[{timestamp}] {message}")

    def register_client(self) -> Dict[str, Any]:
        """Step 1: Register client"""
        self.log("Step 1: Registering client...")
        try:
            response = self.session.post(
                f"{self.base_url}/register_client",
                timeout=30
            )
            response.raise_for_status()
            data = response.json()
            self.cid = data.get('cid')
            self.log(f"register_client -> {response.status_code} {json.dumps(data)}")
            return data
        except requests.exceptions.RequestException as e:
            self.log(f"Error registering client: {e}")
            raise

    def test_echo(self) -> Dict[str, Any]:
        """Step 2: Test echo functionality"""
        self.log("Step 2: Testing echo...")
        try:
            response = self.session.get(
                f"{self.base_url}/api/echo/{self.cid}",
                params={'q': 'from-client'},
                timeout=30
            )
            response.raise_for_status()
            data = response.json()
            self.log(f"GET /api/echo/{self.cid} -> {response.status_code} {json.dumps(data)}")
            return data
        except requests.exceptions.RequestException as e:
            self.log(f"Error testing echo: {e}")
            raise

    def submit_pilot(self) -> Dict[str, Any]:
        """Step 3: Submit a pilot job"""
        self.log("Step 3: Submitting pilot...")
        try:
            pilot_data = {
                "resource": "local.localhost",
                "nodes": 10,
                "runtime": 10
            }
            response = self.session.post(
                f"{self.base_url}/api/pilot_submit/{self.cid}",
                data=json.dumps(pilot_data),
                timeout=30
            )
            response.raise_for_status()
            data = response.json()
            self.log(f"POST /api/pilot_submit/{self.cid} -> {response.status_code} {json.dumps(data)}")
            return data
        except requests.exceptions.RequestException as e:
            self.log(f"Error submitting pilot: {e}")
            raise

    def submit_tasks(self, num_tasks: int = 10) -> List[str]:
        """Step 4: Submit tasks"""
        self.log("Step 4: Submitting tasks...")
        self.tids = []

        for i in range(num_tasks):
            try:
                task_data = {
                    "executable": "date"
                }
                response = self.session.post(
                    f"{self.base_url}/api/task_submit/{self.cid}",
                    data=json.dumps(task_data),
                    timeout=30
                )
                response.raise_for_status()
                data = response.json()
                tid = data.get('tid')
                self.tids.append(tid)
                self.log(f"POST /api/task_submit/{self.cid} -> {response.status_code} {json.dumps(data)}")
            except requests.exceptions.RequestException as e:
                self.log(f"Error submitting task {i+1}: {e}")
                raise

        return self.tids

    def wait_for_tasks(self) -> List[Dict[str, Any]]:
        """Step 5: Wait for tasks to complete"""
        self.log("Step 5: Waiting for tasks to complete...")
        results = []

        for tid in self.tids:
            try:
                response = self.session.get(
                    f"{self.base_url}/api/task_wait/{self.cid}/{tid}",
                    timeout=60
                )
                response.raise_for_status()
                data = response.json()
                stdout = data.get('task', {}).get('stdout', '').strip()
                self.log(f"GET /api/task_wait/{self.cid}/{tid} -> {response.status_code} {stdout}")
                results.append(data)
            except requests.exceptions.RequestException as e:
                self.log(f"Error waiting for task {tid}: {e}")
                raise

        return results

    def unregister_client(self) -> Dict[str, Any]:
        """Step 6: Unregister client"""
        self.log("Step 6: Unregistering client...")
        try:
            response = self.session.post(
                f"{self.base_url}/unregister_client/{self.cid}",
                timeout=30
            )
            response.raise_for_status()
            data = response.json()
            self.log(f"unregister_client -> {response.status_code} {json.dumps(data)}")
            return data
        except requests.exceptions.RequestException as e:
            self.log(f"Error unregistering client: {e}")
            raise

    def execute_workflow(self) -> None:
        """Execute the complete RadicalPilot workflow"""
        self.log("RadicalPilot Execution Started...")
        self.log(f"URL: {self.base_url}")
        self.log("Status: Initializing workflow...")

        try:
            # Step 1: Register client
            self.register_client()

            # Step 2: Test echo
            self.test_echo()

            # Step 3: Submit pilot
            self.submit_pilot()

            # Step 4: Submit tasks
            self.submit_tasks()

            # Step 5: Wait for tasks
            self.wait_for_tasks()

            # Step 6: Unregister client
            self.unregister_client()

            self.log("RadicalPilot workflow completed successfully!")
            self.log(f"End Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

        except Exception as e:
            self.log(f"Error occurred during workflow execution: {e}")
            self.log("Please check the API endpoint and network connectivity.")


def main():
    """Main function to run the RadicalPilot workflow"""
    print("=" * 60)
    print("RadicalPilot Python Client")
    print("=" * 60)

    # Create client and execute workflow
    client = RadicalPilotClient()
    client.execute_workflow()


if __name__ == "__main__":
    main()
