import httpx

from scripts.smoke_test import wait_for_phase


def test_smoke_stops_for_user_selection_before_done():
    for event, status in [("awaiting_user", "AWAITING_USER"), ("done", "DONE"), ("done", "FAILED")]:

        def respond(request, event=event, status=status):
            return httpx.Response(200, text=f'event: {event}\ndata: {{"status": "{status}"}}\n\n')

        with httpx.Client(base_url="http://test", transport=httpx.MockTransport(respond)) as client:
            assert wait_for_phase(client, "test") == status
