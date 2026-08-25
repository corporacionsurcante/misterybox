'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import AdminControlPanel, {
  type Metrics,
  type MerchantRow,
  type PrizeRow,
  type FlagRow,
} from '@/components/admin/AdminControlPanel';

/**
 * Puente entre el Server Component (que trae los datos) y el panel,
 * que es interactivo y necesita handlers del lado del cliente.
 */
export default function AdminPanelClient(props: {
  metrics: Metrics;
  merchants: MerchantRow[];
  prizes: PrizeRow[];
  flags: FlagRow[];
}) {
  const router = useRouter();

  const patch = async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? 'No se pudo guardar el cambio');
    }
  };

  const onToggleMerchant = useCallback(
    async (id: string, enabled: boolean) => {
      await patch(`/api/admin/merchants/${id}`, { isActive: enabled });
      router.refresh();
    },
    [router],
  );

  const onToggleFlag = useCallback(
    async (key: string, enabled: boolean) => {
      await patch(`/api/admin/flags/${encodeURIComponent(key)}`, { enabled });
      router.refresh();
    },
    [router],
  );

  const onUpdatePrize = useCallback(
    async (id: string, p: Partial<PrizeRow>) => {
      const body: Record<string, unknown> = {};
      if (p.realCost !== undefined) body.realCost = p.realCost;
      if (p.baseWeight !== undefined) body.baseWeight = p.baseWeight;
      if (p.poolSafetyMultiplier !== undefined) body.poolSafetyMultiplier = p.poolSafetyMultiplier;
      if (p.isActive !== undefined) body.isActive = p.isActive;
      await patch(`/api/admin/prizes/${id}`, body);
      router.refresh();
    },
    [router],
  );

  return (
    <AdminControlPanel
      {...props}
      onToggleMerchant={onToggleMerchant}
      onToggleFlag={onToggleFlag}
      onUpdatePrize={onUpdatePrize}
      onRefresh={() => router.refresh()}
    />
  );
}
