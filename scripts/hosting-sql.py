#!/usr/bin/env python3
"""Prints the role/database SQL from HOSTING.md section 1 with the two placeholder passwords filled in.
CI runs exactly this text, so the document cannot drift from what works.   usage: hosting-sql.py OWNER_PASSWORD APP_PASSWORD"""
import os, re, sys

owner_pw, app_pw = sys.argv[1], sys.argv[2]
doc = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'HOSTING.md'), encoding='utf8').read()
section = doc.split('## 1. Create the database', 1)[1].split('\n## 2.', 1)[0]
m = re.search(r'```sql\n(.*?)```', section, re.S)
if not m:
    sys.exit('no ```sql block in HOSTING.md section 1')
sql = m.group(1)
for placeholder in ('REPLACE_WITH_OWNER_PASSWORD', 'REPLACE_WITH_APP_PASSWORD'):
    if placeholder not in sql:
        sys.exit(f'{placeholder} is not in the HOSTING.md SQL')
print(sql.replace('REPLACE_WITH_OWNER_PASSWORD', owner_pw).replace('REPLACE_WITH_APP_PASSWORD', app_pw))
