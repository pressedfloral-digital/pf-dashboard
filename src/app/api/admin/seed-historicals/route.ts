import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { secretMatches } from '@/lib/bearerSecret';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const WEEKS = [
  '2025-12-29','2026-01-05','2026-01-12','2026-01-19','2026-01-26',
  '2026-02-02','2026-02-09','2026-02-16','2026-02-23','2026-03-02',
  '2026-03-09','2026-03-16','2026-03-23','2026-03-30',
];

interface SeedRow {
  location: string; department: string; member_name: string;
  hours: (number|null)[]; orders: (number|null)[];
}

const SEED_DATA: SeedRow[] = [
  // UTAH FULFILLMENT
  { location:'Utah', department:'fulfillment', member_name:'Izabella DePrima',
    hours:[2.59,40.06,33.20,39.95,28.11,6.53,39.60,38.67,39.99,39.83,28.76,36.95,37.66,31.54],
    orders:[null,10,8,21,12,null,22,26,18,10,3,6,14,22] },
  { location:'Utah', department:'fulfillment', member_name:'Warner Neuenschwander',
    hours:[null,3.73,5.73,1.12,2.07,7.17,7.21,3.86,2.21,3.48,null,null,null,null],
    orders:[null,16,18,8,5,13,9,23,7,7,null,null,null,null] },
  { location:'Utah', department:'fulfillment', member_name:'Owen Shaw',
    hours:[6.25,10.41,19.80,14.12,13.85,7.41,22.71,17.19,9.04,20.24,12.22,23.19,16.06,26.25],
    orders:[15,23,44,40,31,21,55,55,29,90,35,67,30,78] },
  { location:'Utah', department:'fulfillment', member_name:'Emma Swenson',
    hours:[null,9.77,6.67,12.09,6.10,6.86,4.65,6.43,10.73,4.40,7.02,2.44,6.25,2.04],
    orders:[null,21,25,31,17,15,9,14,35,10,18,10,26,null] },
  // UTAH DESIGN
  { location:'Utah', department:'design', member_name:'Jennika Merrill',
    hours:[null,null,null,null,null,null,null,null,null,null,null,null,null,null],
    orders:[null,3,3,2,22,20,12,5,10,14,10,18,11,15] },
  { location:'Utah', department:'design', member_name:'Deanna L Brown',
    hours:[15.20,18.94,26.29,27.85,24.37,21.31,28.02,27.30,27.30,19.78,20.25,24.64,23.49,19.06],
    orders:[9,10,12,19,18,12,18,25,26,17,19,21,23,18] },
  { location:'Utah', department:'design', member_name:'Sarah Glissmeyer',
    hours:[4.79,14.82,13.95,18.43,18.11,16.66,16.11,9.86,null,9.41,15.46,14.76,16.16,17.18],
    orders:[3,4,null,7,5,9,8,null,null,6,8,9,8,8] },
  { location:'Utah', department:'design', member_name:'Kathryn Hill',
    hours:[8.15,22.50,21.73,21.86,null,24.10,23.33,19.92,9.01,13.87,26.81,4.72,20.11,20.19],
    orders:[6,14,15,14,null,23,15,15,11,7,15,11,14,12] },
  { location:'Utah', department:'design', member_name:'Mia Legas',
    hours:[2.91,13.75,16.20,7.77,11.26,18.38,11.07,20.22,6.27,null,10.86,18.55,16.03,18.56],
    orders:[3,9,11,3,15,26,14,27,6,null,18,13,21,18] },
  { location:'Utah', department:'design', member_name:'Sloane James',
    hours:[null,6.22,null,null,21.53,null,19.53,14.91,23.01,16.57,20.75,19.85,19.28,20.18],
    orders:[null,null,null,null,15,null,14,11,22,16,26,20,19,24] },
  { location:'Utah', department:'design', member_name:'Audrey Brown',
    hours:[null,null,null,1.33,13.64,11.51,9.32,5.76,9.06,9.62,null,8.14,8.92,7.39],
    orders:[null,null,null,null,10,10,3,3,12,7,null,8,8,8] },
  { location:'Utah', department:'design', member_name:'Chloe Leonard',
    hours:[null,null,null,null,null,null,null,5.12,8.17,7.60,null,null,3.90,4.06],
    orders:[null,null,null,null,null,null,null,11,4,9,null,null,4,9] },
  // UTAH PRESERVATION
  { location:'Utah', department:'preservation', member_name:'Katelyn Wilson',
    hours:[20.22,29.68,21.16,13.52,9.10,8.44,15.15,15.55,15.88,10.88,null,25.37,21.87,17.33],
    orders:[24,20,16,21,12,10,25,27,24,11,null,46,33,22] },
  { location:'Utah', department:'preservation', member_name:'Emma Dunakey',
    hours:[null,null,null,null,null,null,null,null,null,null,10.69,null,1.14,7.75],
    orders:[null,null,null,null,null,null,null,null,null,null,19,null,5,15] },
  // GEORGIA FULFILLMENT
  { location:'Georgia', department:'fulfillment', member_name:'Yann Jean-Louis',
    hours:[15.47,37.58,27.75,27.10,32.69,32.99,30.66,35.24,25.86,23.11,28.05,27.84,25.24,24.62],
    orders:[1,5,5,6,5,13,null,null,null,null,4,4,12,4] },
  { location:'Georgia', department:'fulfillment', member_name:'Nahid Knight',
    hours:[12.28,35.25,35.13,26.58,18.10,26.97,34.50,27.21,35.60,18.17,36.30,36.83,24.78,35.86],
    orders:[21,52,44,30,17,47,58,45,47,28,54,51,33,42] },
  { location:'Georgia', department:'fulfillment', member_name:'Shantel Phifer',
    hours:[2.59,9.04,11.07,9.66,null,5.14,7.52,25.90,null,4.72,9.74,13.96,17.92,9.59],
    orders:[4,14,14,14,null,6,10,34,null,6,21,17,26,21] },
  { location:'Georgia', department:'fulfillment', member_name:'Zac Carden',
    hours:[6.05,23.12,21.49,33.22,26.51,null,21.37,22.65,21.72,null,null,null,null,null],
    orders:[9,33,28,43,20,null,39,41,18,null,null,null,null,null] },
  // GEORGIA DESIGN
  { location:'Georgia', department:'design', member_name:'Katherine Piper',
    hours:[null,null,null,null,30.22,38.68,39.67,40.35,32.27,24.85,16.92,38.74,35.41,40.18],
    orders:[20,19,5,3,9,20,9,25,3,8,null,23,15,20] },
  { location:'Georgia', department:'design', member_name:'Allanna Harlan',
    hours:[17.76,34.41,41.05,38.82,30.47,35.66,40.45,39.62,39.99,33.55,40.54,39.51,33.61,39.87],
    orders:[14,23,21,17,14,22,25,26,27,25,23,24,25,25] },
  { location:'Georgia', department:'design', member_name:'Erin Webb',
    hours:[29.94,36.65,39.51,39.18,26.28,44.33,38.16,38.39,39.91,33.99,23.17,40.58,39.15,29.57],
    orders:[28,13,15,16,11,21,16,25,25,21,7,22,20,13] },
  { location:'Georgia', department:'design', member_name:'Rachel Tucker',
    hours:[null,null,null,null,null,null,null,null,41.86,38.88,41.65,41.16,37.59,41.14],
    orders:[null,null,null,null,null,null,null,null,20,22,22,23,19,6] },
  { location:'Georgia', department:'design', member_name:'Celt Stewart',
    hours:[null,6.50,26.67,16.03,30.39,32.10,26.63,32.20,27.34,20.64,15.73,0.29,8.89,9.55],
    orders:[null,4,13,6,18,23,16,13,14,null,null,null,null,3] },
  // GEORGIA PRESERVATION
  { location:'Georgia', department:'preservation', member_name:'Amber Garrett',
    hours:[null,null,null,null,32.78,8.54,3.11,8.49,6.51,5.67,5.82,9.33,6.79,8.84],
    orders:[7,11,2,18,12,24,10,23,17,10,12,23,16,27] },
  { location:'Georgia', department:'preservation', member_name:'Celt Stewart',
    hours:[23.55,22.54,4.93,5.23,null,2.33,7.74,2.12,5.43,10.35,16.95,24.20,27.40,19.40],
    orders:[34,24,14,13,null,7,13,4,13,22,36,40,33,29] },
];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!secretMatches(secret, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const records: {
    location: string; department: string; week_of: string;
    member_name: string; actual_hours: number; actual_orders: number;
    entered_by: string; updated_at: string;
  }[] = [];

  for (const row of SEED_DATA) {
    for (let i = 0; i < WEEKS.length; i++) {
      const h = row.hours[i];
      const o = row.orders[i];
      if (!h && !o) continue;
      records.push({
        location:      row.location,
        department:    row.department,
        week_of:       WEEKS[i],
        member_name:   row.member_name,
        actual_hours:  h ?? 0,
        actual_orders: o ?? 0,
        entered_by:    'seed',
        updated_at:    new Date().toISOString(),
      });
    }
  }

  const { error } = await supabase
    .from('team_member_week_actuals')
    .upsert(records, { onConflict: 'location,department,week_of,member_name' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, seeded: records.length });
}
