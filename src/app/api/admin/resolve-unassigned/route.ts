import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { pfPost } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';

interface SearchItem {
  uuid: string;
  assignedToUserFirstName?:   string | null;
  assignedToUserLastName?:    string | null;
  preservationUserFirstName?: string | null;
  preservationUserLastName?:  string | null;
  fulfillmentUserFirstName?:  string | null;
  fulfillmentUserLastName?:   string | null;
}
interface SearchResponse { items: SearchItem[]; }

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: staffRows } = await supabase
    .from('staff_locations')
    .select('name, location');
  const staffMap: Record<string, string> = {};
  staffRows?.forEach(r => { staffMap[r.name.trim()] = r.location; });

  const { data: unresolved } = await supabase
    .from('uuid_location_cache')
    .select('uuid, order_num')
    .is('location', null);

  if (!unresolved?.length) {
    return NextResponse.json({ resolved: 0, stillUnresolved: 0, message: 'Nothing to resolve' });
  }

  let resolved = 0;
  const BATCH = 50;

  for (let i = 0; i < unresolved.length; i += BATCH) {
    const batch = unresolved.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(row =>
        pfPost<SearchResponse>('/OrderProducts/Search', {
          searchTerm: row.order_num,
          pageNumber: 1,
          pageSize: 1,
          workflowFamily: 'frames',
        }).catch(() => null)
      )
    );

    const updates: { uuid: string; location: string; staff_name: string }[] = [];

    results.forEach((data, j) => {
      const item = data?.items?.[0];
      if (!item) return;
      const candidates = [
        [item.preservationUserFirstName,  item.preservationUserLastName],
        [item.assignedToUserFirstName,    item.assignedToUserLastName],
        [item.fulfillmentUserFirstName,   item.fulfillmentUserLastName],
      ];
      for (const [first, last] of candidates) {
        const name = [first, last].filter(Boolean).join(' ').trim();
        if (name && staffMap[name]) {
          updates.push({ uuid: batch[j].uuid, location: staffMap[name], staff_name: name });
          break;
        }
      }
    });

    if (updates.length) {
      for (const u of updates) {
        await supabase
          .from('uuid_location_cache')
          .update({ location: u.location, staff_name: u.staff_name })
          .eq('uuid', u.uuid);
      }
      resolved += updates.length;
    }
  }

  const stillUnresolved = unresolved.length - resolved;
  return NextResponse.json({
    resolved,
    stillUnresolved,
    message: `Resolved ${resolved} orders. ${stillUnresolved} could not be matched to a staff location.`,
  });
}
