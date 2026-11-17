import { NextResponse } from 'next/server';
import { getAccess, forbidden } from '@/lib/routeAccess';
import { pfGet, pfPost } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';

export const maxDuration = 300;

interface DetailsUpload {
  uploadType:               string;
  uploadedByUserFirstName?: string | null;
  uploadedByUserLastName?:  string | null;
}

interface Details {
  orderProductUploads?: DetailsUpload[];
}

interface SearchItem {
  uuid?:                       string;
  shopifyOrderNumber?:         string;
  preservationUserFirstName?:  string | null;
  preservationUserLastName?:   string | null;
  assignedToUserFirstName?:    string | null;
  assignedToUserLastName?:     string | null;
  fulfillmentUserFirstName?:   string | null;
  fulfillmentUserLastName?:    string | null;
}

interface SearchResponse {
  items?: SearchItem[];
}

export async function GET() {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;
  // Manual admin tool — no dashboard button calls this.
  if (access.role !== 'admin') return forbidden('Admin only');

  try {
    // ── Step 1: Load staff → location map ─────────────────────────────────
    const { data: staffRows } = await supabase
      .from('staff_locations')
      .select('name, location');

    const staffMap: Record<string, string> = {};
    staffRows?.forEach(r => { staffMap[r.name.trim()] = r.location; });

    // ── Step 2: Get all unresolved UUIDs from cache ────────────────────────
    const { data: unresolved } = await supabase
      .from('uuid_location_cache')
      .select('uuid, order_num, status, order_date')
      .is('location', null)
      .neq('status', 'unknown')
      .order('order_num', { ascending: false });

    if (!unresolved?.length) {
      return new NextResponse('order_num,uuid,status,order_date,bouquet_uploaded_by,staff_location,assigned_location,confidence\n', {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="unresolved-orders.csv"',
        },
      });
    }

    // ── Step 3: Fetch Details for each UUID ───────────────────────────────
    // Batch to avoid hammering the API
    const BATCH = 20;
    const rows: {
      orderNum:        string;
      uuid:            string;
      status:          string;
      orderDate:       string;
      bouquetUploader: string;
      staffLocation:   string;
      assignedLocation: string;
      confidence:      string;
    }[] = [];

    for (let i = 0; i < unresolved.length; i += BATCH) {
      const batch = unresolved.slice(i, i + BATCH);

      const results = await Promise.all(
        batch.map(row =>
          pfGet<Details>(`/OrderProducts/Details/${row.uuid}`).catch(() => null)
        )
      );

      for (let j = 0; j < batch.length; j++) {
        const row     = batch[j];
        const details = results[j];

        let bouquetUploader  = '';
        let staffLocation    = '';
        let assignedLocation = '';
        let confidence       = '';

        if (details?.orderProductUploads) {
          // Try bouquet upload first
          const bouquetUpload = details.orderProductUploads.find(
            u => u.uploadType === 'bouquet'
          );

          if (bouquetUpload) {
            const name = [
              bouquetUpload.uploadedByUserFirstName,
              bouquetUpload.uploadedByUserLastName,
            ].filter(Boolean).join(' ').trim();

            bouquetUploader = name || '(no name on bouquet upload)';
            staffLocation   = staffMap[name] ?? 'not in staff_locations table';
            if (staffMap[name]) {
              assignedLocation = staffMap[name];
              confidence       = 'high — bouquet upload match';
            } else {
              assignedLocation = 'unresolvable';
              confidence       = 'low — uploader not in staff table';
            }
          } else {
            // No bouquet upload — try other upload types
            const anyUpload = details.orderProductUploads[0];
            if (anyUpload) {
              const name = [
                anyUpload.uploadedByUserFirstName,
                anyUpload.uploadedByUserLastName,
              ].filter(Boolean).join(' ').trim();
              bouquetUploader  = name ? `${name} (via ${anyUpload.uploadType} upload)` : '(no uploader name)';
              staffLocation    = staffMap[name] ?? 'not in staff_locations table';
              assignedLocation = staffMap[name] ?? 'unresolvable';
              confidence       = staffMap[name] ? 'medium — non-bouquet upload match' : 'low — uploader not in staff table';
            } else {
              bouquetUploader  = '(no uploads found)';
              assignedLocation = 'unresolvable';
              confidence       = 'none — no upload data';
            }
          }
        } else {
          // Details fetch failed or no uploads — try Search API as fallback
          try {
            const search = await pfPost<SearchResponse>('/OrderProducts/Search', {
              searchTerm: row.order_num,
              pageNumber: 1,
              pageSize:   5,
            });
            const item = search?.items?.find(
              i => i.uuid === row.uuid || i.shopifyOrderNumber === row.order_num
            ) ?? search?.items?.[0];

            if (item) {
              const candidates = [
                [item.preservationUserFirstName,  item.preservationUserLastName],
                [item.assignedToUserFirstName,    item.assignedToUserLastName],
                [item.fulfillmentUserFirstName,   item.fulfillmentUserLastName],
              ];
              for (const [first, last] of candidates) {
                const name = [first, last].filter(Boolean).join(' ').trim();
                if (name && staffMap[name]) {
                  bouquetUploader  = `${name} (via Search API staff field)`;
                  staffLocation    = staffMap[name];
                  assignedLocation = staffMap[name];
                  confidence       = 'medium — Search API staff field';
                  break;
                }
              }
              if (!assignedLocation) {
                bouquetUploader  = '(staff fields empty in Search API)';
                assignedLocation = 'unresolvable';
                confidence       = 'none';
              }
            } else {
              bouquetUploader  = '(order not found in Search API)';
              assignedLocation = 'unresolvable';
              confidence       = 'none';
            }
          } catch {
            bouquetUploader  = '(API error)';
            assignedLocation = 'unresolvable';
            confidence       = 'none';
          }
        }

        rows.push({
          orderNum:        row.order_num,
          uuid:            row.uuid,
          status:          row.status,
          orderDate:       row.order_date ?? '',
          bouquetUploader,
          staffLocation,
          assignedLocation,
          confidence,
        });
      }
    }

    // ── Step 4: Build CSV ──────────────────────────────────────────────────
    const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;

    const header = [
      'Order #',
      'UUID',
      'Status',
      'Order Date',
      'Bouquet Uploaded By',
      'Staff Location in Table',
      'Would Assign To',
      'Confidence',
    ].map(escape).join(',');

    const csvRows = rows.map(r => [
      escape(r.orderNum),
      escape(r.uuid),
      escape(r.status),
      escape(r.orderDate),
      escape(r.bouquetUploader),
      escape(r.staffLocation),
      escape(r.assignedLocation),
      escape(r.confidence),
    ].join(','));

    const csv = [header, ...csvRows].join('\n');

    return new NextResponse(csv, {
      headers: {
        'Content-Type':        'text/csv',
        'Content-Disposition': 'attachment; filename="unresolved-orders.csv"',
      },
    });

  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
