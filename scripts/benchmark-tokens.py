#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Optional development-only tokenizer; install tiktoken outside the product."""
import copy, json, sys
import tiktoken

def serialized(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

# Use identical metadata for the same synthetic messages in every candidate.
# Random UUIDs and clock times otherwise change token counts independently of
# paging. Keep message bodies, shapes, cursor calls and page boundaries intact.
reference = json.load(open(sys.argv[1]))
messages = {m['id']: m for p in reference['pages'] for m in p['response']['messages']}

def aligned(data):
    data = copy.deepcopy(data)
    deliveries = {}
    for page in data['pages']:
        for message in page['response']['messages']:
            expected = messages[message['id']]
            assert message['text'] == expected['text'], 'Message content differs'
            deliveries[message['deliveryId']] = expected['deliveryId']
            for field in ('deliveryId', 'from', 'to', 'at'):
                message[field] = expected[field]
    for page in data['pages']:
        for value in (page['request']['arguments'], page['response']):
            if 'cursor' in value:
                value['cursor'] = deliveries[value['cursor']]
    return data

results = {}
for file in sys.argv[1:]:
    data = aligned(json.load(open(file)))
    results[file] = {}
    for encoding in ('o200k_base', 'cl100k_base'):
        encoder = tiktoken.get_encoding(encoding)
        count = lambda value: len(encoder.encode(serialized(value)))
        results[file][encoding] = {
            'tool_catalog_tokens': count(data['tools']),
            'first_inbox_page_tokens': count(data['pages'][0]['response']),
            'full_backlog_workflow_tokens': sum(count(p['request']) + count(p['response']) for p in data['pages']),
            'pages': len(data['pages']),
        }
print(json.dumps(results, indent=2))
