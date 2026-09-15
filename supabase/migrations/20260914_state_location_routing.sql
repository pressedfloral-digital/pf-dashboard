-- Which production location (Utah vs Georgia) a customer's shipping state
-- currently routes to. This mapping isn't derived from anything else in this
-- app — the real routing decision happens outside this repo (Shopify/PF) —
-- this table is Sarah's own planning record of "what we believe today,"
-- editable from the Growth & Distribution tab so she can simulate moving a
-- state between locations. Changing a row here does NOT change live order
-- routing.
create table state_location_routing (
  state_code  text primary key,
  state_name  text not null,
  location    text not null check (location in ('Utah', 'Georgia')),
  updated_at  timestamptz not null default now(),
  updated_by  text
);

insert into state_location_routing (state_code, state_name, location) values
  ('AL', 'Alabama',              'Georgia'),
  ('AK', 'Alaska',               'Utah'),
  ('AZ', 'Arizona',              'Utah'),
  ('AR', 'Arkansas',             'Georgia'),
  ('CA', 'California',           'Utah'),
  ('CO', 'Colorado',             'Utah'),
  ('CT', 'Connecticut',          'Georgia'),
  ('DE', 'Delaware',             'Georgia'),
  ('FL', 'Florida',              'Georgia'),
  ('GA', 'Georgia',              'Georgia'),
  ('HI', 'Hawaii',               'Utah'),
  ('ID', 'Idaho',                'Utah'),
  ('IL', 'Illinois',             'Georgia'),
  ('IN', 'Indiana',              'Georgia'),
  ('IA', 'Iowa',                 'Utah'),
  ('KS', 'Kansas',               'Utah'),
  ('KY', 'Kentucky',             'Georgia'),
  ('LA', 'Louisiana',            'Georgia'),
  ('ME', 'Maine',                'Georgia'),
  ('MD', 'Maryland',             'Utah'),
  ('MA', 'Massachusetts',        'Georgia'),
  ('MI', 'Michigan',             'Georgia'),
  ('MN', 'Minnesota',            'Utah'),
  ('MS', 'Mississippi',          'Georgia'),
  ('MO', 'Missouri',             'Georgia'),
  ('MT', 'Montana',              'Utah'),
  ('NE', 'Nebraska',             'Utah'),
  ('NV', 'Nevada',               'Utah'),
  ('NH', 'New Hampshire',        'Georgia'),
  ('NJ', 'New Jersey',           'Georgia'),
  ('NM', 'New Mexico',           'Utah'),
  ('NY', 'New York',             'Georgia'),
  ('NC', 'North Carolina',       'Georgia'),
  ('ND', 'North Dakota',         'Utah'),
  ('OH', 'Ohio',                 'Utah'),
  ('OK', 'Oklahoma',             'Utah'),
  ('OR', 'Oregon',               'Utah'),
  ('PA', 'Pennsylvania',         'Utah'),
  ('RI', 'Rhode Island',         'Georgia'),
  ('SC', 'South Carolina',       'Georgia'),
  ('SD', 'South Dakota',         'Utah'),
  ('TN', 'Tennessee',            'Utah'),
  ('TX', 'Texas',                'Utah'),
  ('UT', 'Utah',                 'Utah'),
  ('VT', 'Vermont',              'Georgia'),
  ('VA', 'Virginia',             'Georgia'),
  ('WA', 'Washington',           'Utah'),
  ('WV', 'West Virginia',        'Georgia'),
  ('WI', 'Wisconsin',            'Georgia'),
  ('WY', 'Wyoming',              'Utah'),
  ('DC', 'District of Columbia', 'Utah');
