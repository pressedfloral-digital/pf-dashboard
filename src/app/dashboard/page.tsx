import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { Header } from '@/components/dashboard/Header';
import { DashboardClient } from '@/components/dashboard/DashboardClient';
import { pfGet } from '@/lib/pf-api';
import { ImpersonationBanner } from '@/components/dashboard/ImpersonationBanner';

async function getPipelineCounts() {
  try {
    return await pfGet<{ status: string; location: string; count: number }[]>('/OrderProducts/CountsByLocation');
  } catch { return null; }
}

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  // All roles use /dashboard — content is scoped client-side based on role

  const pipeline = await getPipelineCounts();
  return (
    <div className="min-h-screen bg-slate-50">
      <ImpersonationBanner />
      <Header />
      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {!pipeline ? (
          <div className="text-center py-20 text-slate-500">
            Failed to load dashboard data. Check your API credentials.
          </div>
        ) : (
          <DashboardClient pipeline={pipeline} />
        )}
      </main>
    </div>
  );
}
