import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import MysteryBoxUnboxer, { type BoxTier } from '@/components/MysteryBoxUnboxer';

export const dynamic = 'force-dynamic';

export default async function AbrirCajaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect(`/login?next=/cajas/${id}`);

  const box = await prisma.userBox.findFirst({
    where: { id, userId: session.user.id },
    include: { boxCatalog: true },
  });

  if (!box) notFound();

  if (box.status !== 'AVAILABLE') {
    redirect('/billetera');
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10">
      <div className="mx-auto max-w-2xl">
        <Link
          href="/cajas"
          className="mb-6 inline-flex items-center gap-2 text-sm text-slate-400 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" /> Volver a mis cajas
        </Link>

        <MysteryBoxUnboxer userBoxId={box.id} tier={box.tier as BoxTier} />
      </div>
    </main>
  );
}
