import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, ArrowRight, Store, Save, Trash2, AlertTriangle, CheckCircle2, RefreshCw, Info, PackageSearch, XCircle, ChevronDown, ChevronUp, RotateCcw, Clock, Radar } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getIntegrations, getChatbot, testEcommerceConnection, testSuriConnection, updateIntegration, updateChatbot, type StoreItem } from '@/services/api';
import { CHATBOT_FIELDS, POLLING_ONLY_PLATFORMS, type ChatbotPlatform } from '@/types';
import { useGsapStagger } from '@/hooks/use-gsap';
import { parseApiError } from '@/lib/parseApiError';
import type { SyncSchedule, SyncScheduleHistoryEntry, SyncResultItem, CatalogPolling } from '@/types';
import { SyncResultRow } from '@/components/sync-result-row';

// ─── Types ───────────────────────────────────────────────────────────────────

interface StoreMapping {
  ecommerceStoreId: string;
  ecommerceStoreName: string;
  chatbotStoreId: string;
  chatbotStoreName: string;
}

interface SyncSummary {
  categories_created: number;
  categories_updated: number;
  products_created: number;
  products_updated: number;
  errors: number;
}

interface SyncCatalogResult {
  success: boolean;
  summary: SyncSummary;
  results: SyncResultItem[];
  resolvedStoreId: string | null;
  platform: string;
  message?: string;
  syncedAt: string;
}

const SYNC_RESULT_KEY = 'coderise_sync_catalog_result';

// ─── SyncProgress ─────────────────────────────────────────────────────────────
const SYNC_STEPS = [
  'Conectando ao e-commerce...',
  'Buscando categorias...',
  'Sincronizando categorias...',
  'Buscando produtos...',
  'Sincronizando produtos...',
  'Finalizando...',
];

const SyncProgress = () => {
  const [elapsed, setElapsed] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    const tick = setInterval(() => setElapsed(s => s + 1), 1000);
    const stepTick = setInterval(() => setStepIdx(i => Math.min(i + 1, SYNC_STEPS.length - 1)), 4000);
    return () => { clearInterval(tick); clearInterval(stepTick); };
  }, []);

  const pct = Math.min(95, Math.round(((stepIdx + 1) / SYNC_STEPS.length) * 100));
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          <span>{SYNC_STEPS[stepIdx]}</span>
        </div>
        <span className="text-xs text-muted-foreground font-mono">{timeStr}</span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-1000"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Sincronizando catálogo completo. Pode levar alguns minutos dependendo do tamanho do catálogo.
      </p>
    </div>
  );
};

// ─── Component ───────────────────────────────────────────────────────────────

const StoreMapping = () => {
  const [loading, setLoading] = useState(true);
  const [loadingStores, setLoadingStores] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncCatalogResult | null>(null);
  const [showAllResults, setShowAllResults] = useState(false);

  const [ecommerceStores, setEcommerceStores] = useState<StoreItem[]>([]);
  const [chatbotStores, setChatbotStores] = useState<StoreItem[]>([]);
  const [mappings, setMappings] = useState<StoreMapping[]>([]);

  const [ecommercePlatform, setEcommercePlatform] = useState('');
  const [ecommerceConfig, setEcommerceConfig] = useState<Record<string, string>>({});
  const [chatbotPlatform, setChatbotPlatform] = useState('');
  const [suriEndpoint, setSuriEndpoint] = useState('');
  const [suriToken, setSuriToken] = useState('');
  const [chatbotConfig, setChatbotConfig] = useState<Record<string, string>>({});

  const [ecommerceStatus, setEcommerceStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [chatbotStatus, setChatbotStatus] = useState<'idle' | 'ok' | 'error'>('idle');

  const [syncSchedule, setSyncSchedule] = useState<SyncSchedule>({ enabled: false, times: [], timezone: 'America/Sao_Paulo' });
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [showScheduleHistory, setShowScheduleHistory] = useState(false);

  const [catalogPolling, setCatalogPolling] = useState<CatalogPolling>({ intervalMinutes: 10 });
  const [savingPolling, setSavingPolling] = useState(false);

  const syncPanelRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const containerRef = useGsapStagger<HTMLDivElement>([loading], { stagger: 0.1, y: 20, delay: 0.05 });

  useEffect(() => {
    Promise.all([getIntegrations(), getChatbot()])
      .then(([intRes, chatRes]) => {
        const i = (intRes as any).integration;
        const c = (chatRes as any).chatbot;
        if (i) {
          setEcommercePlatform(i.ecommerce_platform || '');
          const cfg = i.ecommerce_config || {};
          setEcommerceConfig(cfg);
          if (cfg._store_mappings) {
            try {
              const savedMappings: StoreMapping[] = JSON.parse(cfg._store_mappings);
              setMappings(savedMappings);
              // Pre-populate store lists from saved mapping data so dropdowns show on reload
              const ecStores = [...new Map(savedMappings.map(m => [m.ecommerceStoreId, { id: m.ecommerceStoreId, name: m.ecommerceStoreName }])).values()];
              const cbStores = [...new Map(savedMappings.map(m => [m.chatbotStoreId, { id: m.chatbotStoreId, name: m.chatbotStoreName }])).values()];
              if (ecStores.length > 0) setEcommerceStores(ecStores);
              if (cbStores.length > 0) setChatbotStores(cbStores);
            } catch { /* ignore */ }
          }
          if (cfg._ecommerce_stores) { try { setEcommerceStores(JSON.parse(cfg._ecommerce_stores)); setEcommerceStatus('ok'); } catch { /* ignore */ } }
          if (i.sync_schedule) setSyncSchedule({ enabled: false, times: [], timezone: 'America/Sao_Paulo', ...i.sync_schedule });
          if (i.catalog_polling) setCatalogPolling({ intervalMinutes: 10, ...i.catalog_polling });
        }
        if (c) {
          const ccfg = c.chatbot_config || {};
          setChatbotPlatform(c.chatbot_platform || i?.chatbot_platform || '');
          // chatbot_config.endpoint/token is the current credential; suri_endpoint/token is legacy fallback
          setSuriEndpoint(ccfg.endpoint || c.suri_endpoint || i?.suri_endpoint || '');
          setSuriToken(ccfg.token    || c.suri_token    || i?.suri_token    || '');
          setChatbotConfig(ccfg);
        }
      })
      .catch(() => toast({ title: 'Erro ao carregar configurações', variant: 'destructive' }))
      .finally(() => setLoading(false));
  }, []);

  // Restaura resultado da última sincronização da memória do navegador
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(SYNC_RESULT_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Discard stale data where item.name is a non-string (would cause React error #31)
        const safe = !Array.isArray(parsed?.results) || parsed.results.every((r: any) => r.name == null || typeof r.name === 'string');
        if (safe) setSyncResult(parsed);
        else sessionStorage.removeItem(SYNC_RESULT_KEY);
      }
    } catch { /* ignore */ }
  }, []);

  const loadStores = async () => {
    setLoadingStores(true);
    setEcommerceStatus('idle');
    setChatbotStatus('idle');

    const results = await Promise.allSettled([
      (async () => {
        if (!ecommercePlatform || !ecommerceConfig) return [];
        const { _connection_status: _s, _connection_msg: _m, _store_mappings: _mp, _ecommerce_stores: _es, ...cleanConfig } = ecommerceConfig;
        const res = await testEcommerceConnection(ecommercePlatform, cleanConfig);
        if (!res.success) throw new Error(res.message || 'Falha ao conectar e-commerce');
        return res.stores || [];
      })(),
      (async () => {
        if (!suriEndpoint || !suriToken) return [];
        const res = await testSuriConnection(suriEndpoint, suriToken);
        if (!res.success) throw new Error(res.message || 'Falha ao conectar chatbot');
        return res.stores || [];
      })(),
    ]);

    const [ecResult, cbResult] = results;

    if (ecResult.status === 'fulfilled') {
      setEcommerceStores(ecResult.value as StoreItem[]);
      setEcommerceStatus('ok');
    } else {
      setEcommerceStatus('error');
      toast({ title: 'E-commerce', description: (ecResult as any).reason?.message, variant: 'destructive' });
    }

    if (cbResult.status === 'fulfilled') {
      setChatbotStores(cbResult.value as StoreItem[]);
      setChatbotStatus('ok');
    } else {
      setChatbotStatus('error');
      toast({ title: 'Chatbot', description: (cbResult as any).reason?.message, variant: 'destructive' });
    }

    setLoadingStores(false);
  };

  const addMapping = () => {
    if (ecommerceStores.length === 0 || chatbotStores.length === 0) return;
    const ec = ecommerceStores[0];
    const cb = chatbotStores[0];
    const already = mappings.some(m => m.ecommerceStoreId === ec.id);
    if (already) { toast({ title: 'Loja já mapeada', variant: 'destructive' }); return; }
    setMappings(prev => [...prev, { ecommerceStoreId: ec.id, ecommerceStoreName: ec.name, chatbotStoreId: cb.id, chatbotStoreName: cb.name }]);
  };

  const updateMapping = (idx: number, field: keyof StoreMapping, value: string) => {
    setMappings(prev => {
      const next = [...prev];
      const store = field === 'ecommerceStoreId' ? ecommerceStores.find(s => s.id === value) : chatbotStores.find(s => s.id === value);
      next[idx] = {
        ...next[idx],
        [field]: value,
        ...(field === 'ecommerceStoreId' && store ? { ecommerceStoreName: store.name } : {}),
        ...(field === 'chatbotStoreId' && store ? { chatbotStoreName: store.name } : {}),
      };
      return next;
    });
  };

  const removeMapping = (idx: number) => setMappings(prev => prev.filter((_, i) => i !== idx));

  const handleSave = async () => {
    setSaving(true);
    try {
      // Remove campos de cache de lojas ao salvar — lojas são sempre carregadas ao vivo
      const { _ecommerce_stores: _es, ...baseCfg } = ecommerceConfig;
      const { _chatbot_stores: _cs, ...baseChatbotCfg } = chatbotConfig;
      const updatedEcommerceCfg = { ...baseCfg, _store_mappings: JSON.stringify(mappings) };
      const updatedChatbotCfg = { ...baseChatbotCfg };
      await Promise.all([
        updateIntegration({ ecommerce_config: updatedEcommerceCfg }),
        updateChatbot({ chatbot_config: updatedChatbotCfg }),
      ]);
      setEcommerceConfig(updatedEcommerceCfg);
      setChatbotConfig(updatedChatbotCfg);
      toast({ title: '✅ Mapeamentos salvos com sucesso!' });
    } catch (err: unknown) {
      toast({ title: 'Erro ao salvar', description: err instanceof Error ? err.message : '', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  // ── Sync Catalog ─────────────────────────────────────────────────────────
  // Chamada de rede pura, reaproveitada tanto pelo botão manual quanto pelo agendamento automático.
  // A sincronização roda em segundo plano no servidor (pode levar minutos em
  // catálogos grandes) — o POST só dispara e o GET consulta o progresso, pra
  // não depender de uma única requisição ficar aberta o tempo todo (proxies
  // de hospedagem costumam cortar isso bem antes de terminar).
  const performCatalogSync = async (): Promise<SyncCatalogResult> => {
    const API_BASE = (import.meta as any).env?.VITE_API_URL || '';
    let authToken = '';
    try {
      const { useAuthStore } = await import('@/store/auth');
      authToken = useAuthStore.getState().token || '';
    } catch { /* fallback */ }

    const headers = {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    };

    const fetchJson = async (method: 'POST' | 'GET') => {
      const res = await fetch(`${API_BASE}/sync-catalog`, { method, headers });
      // Lê o corpo como texto primeiro para evitar "Unexpected end of JSON input"
      const rawText = await res.text();
      if (!rawText || rawText.trim() === '') {
        throw new Error(`Servidor retornou resposta vazia (HTTP ${res.status}). Verifique se a rota /sync-catalog está configurada no vercel.json.`);
      }
      try {
        return JSON.parse(rawText);
      } catch {
        throw new Error(`Resposta inválida do servidor (HTTP ${res.status}): ${rawText.slice(0, 200)}`);
      }
    };

    await fetchJson('POST');

    const MAX_POLLS = 400; // ~20min a 3s por consulta — teto de segurança
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const data = await fetchJson('GET');
      if (data.status !== 'running') {
        return { ...data, syncedAt: new Date().toISOString() };
      }
    }
    throw new Error('A sincronização está demorando mais que o esperado. Tente novamente em alguns minutos.');
  };

  const handleSyncCatalog = async () => {
    setSyncing(true);
    setShowAllResults(false);
    try {
      const result = await performCatalogSync();
      setSyncResult(result);
      try { sessionStorage.setItem(SYNC_RESULT_KEY, JSON.stringify(result)); } catch { /* ignore */ }

      if (result.success) {
        const { summary } = result;
        toast({
          title: '✅ Sincronização concluída!',
          description: `${summary.categories_created + summary.categories_updated} categorias · ${summary.products_created + summary.products_updated} produtos · ${summary.errors} erro(s)`,
        });
      } else {
        const errMsg = result.message || 'Erro desconhecido';
        const parsed = parseApiError(errMsg, 'general');
        toast({
          title: parsed.title || 'Sincronização com erros',
          description: parsed.hint ? `${parsed.description} ${parsed.hint}` : parsed.description,
          variant: 'destructive',
        });
      }

      setTimeout(() => syncPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    } catch (err: unknown) {
      toast({ title: 'Erro na sincronização', description: err instanceof Error ? err.message : 'Erro desconhecido', variant: 'destructive' });
    } finally {
      setSyncing(false);
    }
  };

  const clearSyncResult = () => {
    setSyncResult(null);
    try { sessionStorage.removeItem(SYNC_RESULT_KEY); } catch { /* ignore */ }
  };

  // ── Agendamento de Sincronização Automática ──────────────────────────────
  const updateScheduleTime = (index: number, value: string) => {
    setSyncSchedule(prev => {
      const times = [...prev.times];
      if (value) times[index] = value; else times.splice(index, 1);
      return { ...prev, times: times.filter(Boolean) };
    });
  };

  const addScheduleSlot = () => setSyncSchedule(prev => prev.times.length < 2 ? { ...prev, times: [...prev.times, '08:00'] } : prev);
  const removeScheduleSlot = (index: number) => setSyncSchedule(prev => ({ ...prev, times: prev.times.filter((_, i) => i !== index) }));

  const handleSaveSchedule = async () => {
    setSavingSchedule(true);
    try {
      const payload: SyncSchedule = { ...syncSchedule, enabled: syncSchedule.enabled && syncSchedule.times.length > 0 };
      await updateIntegration({ sync_schedule: payload });
      setSyncSchedule(prev => ({ ...prev, enabled: payload.enabled }));
      toast({ title: '✅ Agendamento salvo!', description: payload.enabled ? `Sincronização automática ativa às ${payload.times.join(' e ')} (enquanto o dashboard estiver aberto).` : 'Sincronização automática desativada.' });
    } catch (err: unknown) {
      toast({ title: 'Erro ao salvar agendamento', description: err instanceof Error ? err.message : '', variant: 'destructive' });
    } finally {
      setSavingSchedule(false);
    }
  };

  // ── Sincronização Incremental (Polling) ──────────────────────────────────
  // Só existe pra plataformas sem webhook (POLLING_ONLY_PLATFORMS) — a
  // execução em si roda no servidor (cron interno do Hostinger a cada 5min,
  // ou /cron-sync-stores externo), este handler só salva a preferência.
  const handleSavePolling = async () => {
    setSavingPolling(true);
    try {
      await updateIntegration({ catalog_polling: { intervalMinutes: catalogPolling.intervalMinutes } });
      toast({ title: '✅ Intervalo salvo!', description: `Sincronização incremental a cada ${catalogPolling.intervalMinutes} minutos.` });
    } catch (err: unknown) {
      toast({ title: 'Erro ao salvar', description: err instanceof Error ? err.message : '', variant: 'destructive' });
    } finally {
      setSavingPolling(false);
    }
  };

  // Roda enquanto o dashboard estiver aberto: a cada 30s checa se bateu algum
  // horário configurado (fuso do agendamento) e, se sim, dispara o mesmo fluxo
  // de sincronização do botão manual — no máximo uma vez por horário/dia.
  const scheduleRunningRef = useRef(false);
  useEffect(() => {
    if (!syncSchedule.enabled || syncSchedule.times.length === 0) return;

    const checkSchedule = async () => {
      if (scheduleRunningRef.current || syncing) return;

      const timezone = syncSchedule.timezone || 'America/Sao_Paulo';
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date());
      const get = (type: string) => parts.find(p => p.type === type)?.value || '';
      const today = `${get('year')}-${get('month')}-${get('day')}`;
      const hhmm = `${get('hour')}:${get('minute')}`;

      const lastRun = syncSchedule.lastRun && syncSchedule.lastRun.date === today ? syncSchedule.lastRun : { date: today, times: [] as string[] };
      const dueSlot = syncSchedule.times.find(t => t === hhmm && !lastRun.times.includes(t));
      if (!dueSlot) return;

      scheduleRunningRef.current = true;
      setSyncing(true);
      setShowAllResults(false);
      let historyEntry: SyncScheduleHistoryEntry;
      try {
        const result = await performCatalogSync();
        setSyncResult(result);
        try { sessionStorage.setItem(SYNC_RESULT_KEY, JSON.stringify(result)); } catch { /* ignore */ }
        // Guarda os erros individuais (não só o total) pra manter a mesma
        // identificação detalhada da sincronização assistida, mesmo depois
        // que a aba for fechada/recarregada. Limita a 50 pra não inflar
        // demais o registro salvo (sync_schedule.history, até 15 execuções).
        const errors = (result.results || []).filter(r => r.type === 'error').slice(0, 50);
        historyEntry = { at: new Date().toISOString(), slot: dueSlot, success: result.success, message: result.message || null, summary: result.summary || null, errors };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Erro desconhecido';
        historyEntry = { at: new Date().toISOString(), slot: dueSlot, success: false, message, summary: null, errors: [{ type: 'error', entity: 'general', message }] };
      }
      setSyncing(false);

      const updatedLastRun = { date: today, times: [...lastRun.times, dueSlot] };
      const history = [historyEntry, ...(syncSchedule.history || [])].slice(0, 15);
      const updatedSchedule: SyncSchedule = { ...syncSchedule, lastRun: updatedLastRun, lastResult: historyEntry, history };
      setSyncSchedule(updatedSchedule);
      updateIntegration({ sync_schedule: updatedSchedule }).catch(() => { /* tenta de novo no próximo check */ });

      toast({
        title: historyEntry.success ? '✅ Sincronização automática concluída' : 'Sincronização automática com erros',
        description: `Horário ${dueSlot}${historyEntry.message ? ` — ${historyEntry.message}` : ''}`,
        variant: historyEntry.success ? undefined : 'destructive',
      });
      scheduleRunningRef.current = false;
    };

    checkSchedule();
    const id = setInterval(checkSchedule, 30000);
    return () => clearInterval(id);
  }, [syncSchedule, syncing]);

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const hasCredentials = ecommercePlatform && suriEndpoint && suriToken;
  const PREVIEW_COUNT = 50;

  return (
    <div ref={containerRef} className="space-y-6">
      <div style={{ opacity: 0 }}>
        <h1 className="text-2xl font-bold">Mapeamento de Lojas</h1>
        <p className="text-muted-foreground">Vincule lojas do E-commerce às lojas do Chatbot para sincronizar produtos</p>
      </div>

      {/* ── Lojas Disponíveis ── */}
      <Card style={{ opacity: 0 }}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Store className="h-5 w-5" /> Lojas Disponíveis</CardTitle>
          <CardDescription>Conecte-se às plataformas para listar as lojas disponíveis</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasCredentials && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>Configure e salve as credenciais do <strong>E-commerce</strong> e do <strong>Chatbot</strong> antes de carregar as lojas.</AlertDescription>
            </Alert>
          )}

          {hasCredentials && ecommerceStatus === 'idle' && chatbotStatus === 'idle' && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>Clique em <strong>Carregar Lojas</strong> para verificar a conexão com as credenciais atuais e atualizar a lista.</AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-lg border p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">E-commerce</span>
                {ecommerceStatus === 'ok' && <Badge variant="outline" className="border-green-500 text-green-600 text-xs gap-1"><CheckCircle2 className="h-3 w-3" />Conectado</Badge>}
                {ecommerceStatus === 'error' && <Badge variant="destructive" className="text-xs">Erro</Badge>}
              </div>
              {ecommerceStores.length > 0 ? (
                <ul className="space-y-1">{ecommerceStores.map(s => (
                  <li key={s.id} className="text-sm flex items-center gap-2 text-muted-foreground">
                    <Store className="h-3 w-3 shrink-0" /><span className="truncate">{s.name}</span>
                    <code className="text-xs bg-muted px-1 rounded ml-auto shrink-0">#{s.id}</code>
                  </li>
                ))}</ul>
              ) : <p className="text-xs text-muted-foreground italic">Nenhuma loja carregada</p>}
            </div>

            <div className="rounded-lg border p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  Chatbot
                  {chatbotPlatform && (
                    <span className="text-muted-foreground font-normal ml-1">
                      ({CHATBOT_FIELDS[chatbotPlatform as ChatbotPlatform]?.label || chatbotPlatform})
                    </span>
                  )}
                </span>
                {chatbotStatus === 'ok' && <Badge variant="outline" className="border-green-500 text-green-600 text-xs gap-1"><CheckCircle2 className="h-3 w-3" />Conectado</Badge>}
                {chatbotStatus === 'error' && <Badge variant="destructive" className="text-xs">Erro</Badge>}
              </div>
              {chatbotStores.length > 0 ? (
                <ul className="space-y-1">{chatbotStores.map(s => (
                  <li key={s.id} className="text-sm flex items-center gap-2 text-muted-foreground">
                    <Store className="h-3 w-3 shrink-0" /><span className="truncate">{s.name}</span>
                    <code className="text-xs bg-muted px-1 rounded ml-auto shrink-0">#{s.id}</code>
                  </li>
                ))}</ul>
              ) : <p className="text-xs text-muted-foreground italic">Nenhuma loja carregada</p>}
            </div>
          </div>

          <Button onClick={loadStores} disabled={loadingStores || !hasCredentials} variant="outline">
            {loadingStores ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Carregando...</> : <><RefreshCw className="mr-2 h-4 w-4" />Carregar Lojas</>}
          </Button>
        </CardContent>
      </Card>

      {/* ── Mapeamentos ── */}
      <Card style={{ opacity: 0 }}>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="flex items-center gap-2"><ArrowRight className="h-5 w-5" /> Mapeamentos</CardTitle>
              <CardDescription>Cada linha define de qual loja do e-commerce os produtos serão sincronizados para qual loja do chatbot</CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={addMapping} disabled={ecommerceStores.length === 0 || chatbotStores.length === 0}>
              + Adicionar Mapeamento
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert className="mb-2">
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Cada mapeamento define: <strong>qual loja do E-commerce</strong> (Store ID <code className="bg-muted px-1 rounded">{ecommerceConfig.store_id || '—'}</code>) envia produtos para <strong>qual loja/depósito do Chatbot</strong>.
            </AlertDescription>
          </Alert>

          {mappings.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground text-sm space-y-2">
              <Store className="h-8 w-8 mx-auto opacity-30" />
              <p>Nenhum mapeamento configurado.</p>
              <p className="text-xs">Carregue as lojas e clique em <strong>+ Adicionar Mapeamento</strong>.</p>
            </div>
          ) : mappings.map((m, idx) => (
            <div key={idx} className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30 flex-wrap">
              <div className="flex-1 min-w-[150px]">
                <p className="text-xs text-muted-foreground mb-1">Loja E-commerce</p>
                <Select value={m.ecommerceStoreId} onValueChange={(v) => updateMapping(idx, 'ecommerceStoreId', v)}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Selecionar loja" /></SelectTrigger>
                  <SelectContent>{ecommerceStores.map(s => <SelectItem key={s.id} value={s.id}>{s.name} <span className="text-xs text-muted-foreground ml-1">#{s.id}</span></SelectItem>)}</SelectContent>
                </Select>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 mt-4" />
              <div className="flex-1 min-w-[150px]">
                <p className="text-xs text-muted-foreground mb-1">Loja Chatbot (Suri)</p>
                <Select value={m.chatbotStoreId} onValueChange={(v) => updateMapping(idx, 'chatbotStoreId', v)}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Selecionar loja" /></SelectTrigger>
                  <SelectContent>{chatbotStores.map(s => <SelectItem key={s.id} value={s.id}>{s.name} <span className="text-xs text-muted-foreground ml-1">#{s.id}</span></SelectItem>)}</SelectContent>
                </Select>
              </div>
              <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive mt-4 shrink-0" onClick={() => removeMapping(idx)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}

          {mappings.length > 0 && (
            <Button onClick={handleSave} disabled={saving} className="mt-2">
              {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Salvando...</> : <><Save className="mr-2 h-4 w-4" />Salvar Mapeamentos</>}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ── Sincronização de Catálogo ── */}
      <Card style={{ opacity: 0 }}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PackageSearch className="h-5 w-5" />
            Sincronização de Catálogo
          </CardTitle>
          <CardDescription>
            Lê todas as categorias e produtos do e-commerce e cria/atualiza na plataforma do chatbot.
            Os resultados são exibidos abaixo e ficam na memória do navegador até você fechar a aba.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasCredentials && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>Configure as credenciais do <strong>E-commerce</strong> e do <strong>Chatbot</strong> antes de sincronizar.</AlertDescription>
            </Alert>
          )}

          {ecommercePlatform === 'vtex' && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs">
                A sincronização em lote de catálogo ainda não está disponível para <strong>VTEX</strong>.
                Produtos continuam sendo recebidos via webhooks normalmente.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <Button
              onClick={handleSyncCatalog}
              disabled={syncing || !hasCredentials || (ecommerceStatus === 'error') || (chatbotStatus === 'error')}
              className="gap-2"
            >
              {syncing
                ? <><Loader2 className="h-4 w-4 animate-spin" />Sincronizando...</>
                : <><PackageSearch className="h-4 w-4" />Sincronizar Catálogo</>}
            </Button>

            {syncResult && !syncing && (
              <Button variant="ghost" size="sm" onClick={clearSyncResult} className="text-muted-foreground gap-1">
                <RotateCcw className="h-3.5 w-3.5" />Limpar resultados
              </Button>
            )}
          </div>

          {/* ── Sincronização Automática ── */}
          <div className="rounded-lg border p-4 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Sincronização Automática</p>
                  <p className="text-xs text-muted-foreground">Sincronize o catálogo automaticamente até 2x por dia, nos horários que você definir — enquanto este painel estiver aberto no navegador.</p>
                </div>
              </div>
              <Switch
                checked={syncSchedule.enabled}
                onCheckedChange={(checked) => setSyncSchedule(prev => ({ ...prev, enabled: checked }))}
                disabled={!hasCredentials}
              />
            </div>

            {syncSchedule.enabled && (
              <div className="space-y-3">
                {syncSchedule.times.length === 0 && (
                  <p className="text-xs text-muted-foreground italic">Adicione ao menos um horário para ativar a sincronização automática.</p>
                )}
                {syncSchedule.times.map((time, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground w-16 shrink-0">Horário {idx + 1}</Label>
                    <Input
                      type="time"
                      value={time}
                      onChange={(e) => updateScheduleTime(idx, e.target.value)}
                      className="h-8 w-32 text-sm"
                    />
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive shrink-0" onClick={() => removeScheduleSlot(idx)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                {syncSchedule.times.length < 2 && (
                  <Button variant="outline" size="sm" onClick={addScheduleSlot}>+ Adicionar horário</Button>
                )}
                <p className="text-xs text-muted-foreground">Horário de Brasília (America/Sao_Paulo).</p>
              </div>
            )}

            {syncSchedule.lastResult && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setShowScheduleHistory(v => !v)}
                  className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground transition-colors"
                >
                  {syncSchedule.lastResult.success ? <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" /> : <XCircle className="h-3 w-3 text-destructive shrink-0" />}
                  Última sincronização automática: {new Date(syncSchedule.lastResult.at).toLocaleString('pt-BR')}
                  {showScheduleHistory ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>

                {showScheduleHistory && syncSchedule.history && syncSchedule.history.length > 0 && (
                  <div className="rounded-lg border overflow-hidden">
                    <div className="bg-muted/40 px-3 py-1.5">
                      <span className="text-xs font-medium text-muted-foreground">Histórico de sincronizações automáticas</span>
                    </div>
                    <div className="divide-y max-h-64 overflow-y-auto">
                      {syncSchedule.history.map((entry, idx) => (
                        <div key={idx} className="flex items-start gap-2 px-3 py-2 text-xs">
                          {entry.success ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" /> : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium">{new Date(entry.at).toLocaleString('pt-BR')}</span>
                              <code className="text-muted-foreground bg-muted px-1 rounded shrink-0">{entry.slot}</code>
                            </div>
                            {entry.summary && (
                              <p className="text-muted-foreground mt-0.5">
                                {(entry.summary.categories_created ?? 0) + (entry.summary.categories_updated ?? 0)} categorias · {(entry.summary.products_created ?? 0) + (entry.summary.products_updated ?? 0)} produtos
                                {(entry.summary.errors ?? 0) > 0 ? ` · ${entry.summary.errors} erro(s)` : ''}
                              </p>
                            )}
                            {!entry.success && entry.errors && entry.errors.length > 0 && (
                              <div className="mt-1 rounded border divide-y overflow-hidden">
                                {entry.errors.map((item, errIdx) => (
                                  <SyncResultRow key={errIdx} item={item} />
                                ))}
                              </div>
                            )}
                            {/* Fallback pra execuções registradas antes de guardar os erros individuais */}
                            {!entry.success && !entry.errors?.length && entry.message && (
                              <p className="text-destructive mt-0.5 break-words">{entry.message}</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <Button size="sm" onClick={handleSaveSchedule} disabled={savingSchedule || !hasCredentials} className="gap-2">
              {savingSchedule ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Salvando...</> : <><Save className="h-3.5 w-3.5" />Salvar agendamento</>}
            </Button>
          </div>

          {/* ── Sincronização Incremental (Polling) — automática pra plataformas sem webhook ── */}
          {POLLING_ONLY_PLATFORMS.includes(ecommercePlatform as typeof POLLING_ONLY_PLATFORMS[number]) && (
            <div className="rounded-lg border p-4 space-y-4">
              <div className="flex items-center gap-2">
                <Radar className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Sincronização Incremental</p>
                  <p className="text-xs text-muted-foreground">
                    Esta plataforma não envia webhooks, então verificamos periodicamente o que mudou no
                    catálogo automaticamente (só o que mudou é reenviado — sem recarregar tudo a cada vez).
                    Não precisa ativar nada, só ajustar o intervalo se quiser.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground shrink-0">Intervalo</Label>
                <Select
                  value={String(catalogPolling.intervalMinutes)}
                  onValueChange={(v) => setCatalogPolling(prev => ({ ...prev, intervalMinutes: Number(v) as CatalogPolling['intervalMinutes'] }))}
                  disabled={!hasCredentials}
                >
                  <SelectTrigger className="h-8 w-40 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">A cada 10 minutos</SelectItem>
                    <SelectItem value="15">A cada 15 minutos</SelectItem>
                    <SelectItem value="30">A cada 30 minutos</SelectItem>
                    <SelectItem value="60">A cada 60 minutos</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {catalogPolling.lastResult && (
                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  {catalogPolling.lastResult.success
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />
                    : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />}
                  <span>
                    Última verificação: {new Date(catalogPolling.lastResult.at).toLocaleString('pt-BR')} — {catalogPolling.lastResult.message}
                  </span>
                </div>
              )}

              <Button size="sm" onClick={handleSavePolling} disabled={savingPolling || !hasCredentials} className="gap-2">
                {savingPolling ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Salvando...</> : <><Save className="h-3.5 w-3.5" />Salvar</>}
              </Button>
            </div>
          )}

          {syncing && <SyncProgress />}

          {/* ── Results Panel ── */}
          {syncResult && !syncing && (
            <div ref={syncPanelRef} className="space-y-3">

              {/* Summary */}
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-sm font-medium flex items-center gap-2">
                    {syncResult.success
                      ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                      : <XCircle className="h-4 w-4 text-destructive" />}
                    Resultado da sincronização
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(syncResult.syncedAt).toLocaleString('pt-BR')}
                    {syncResult.resolvedStoreId && (
                      <> · Loja Suri: <code className="bg-muted px-1 rounded">#{syncResult.resolvedStoreId}</code></>
                    )}
                  </span>
                </div>

                {syncResult.summary && (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    {[
                      { value: syncResult.summary.categories_created, label: 'Cat. criadas', color: 'green' },
                      { value: syncResult.summary.categories_updated, label: 'Cat. atualizadas', color: 'blue' },
                      { value: syncResult.summary.products_created, label: 'Prod. criados', color: 'green' },
                      { value: syncResult.summary.products_updated, label: 'Prod. atualizados', color: 'blue' },
                      { value: syncResult.summary.errors, label: 'Erros', color: syncResult.summary.errors > 0 ? 'red' : 'gray' },
                    ].map(({ value, label, color }) => (
                      <div key={label} className={`rounded-md border p-2 text-center ${color === 'green' ? 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-900' :
                          color === 'blue' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900' :
                            color === 'red' ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900' :
                              'bg-muted border-border'
                        }`}>
                        <p className={`text-lg font-bold ${color === 'green' ? 'text-green-700 dark:text-green-400' :
                            color === 'blue' ? 'text-blue-700 dark:text-blue-400' :
                              color === 'red' ? 'text-destructive' :
                                'text-muted-foreground'
                          }`}>{value}</p>
                        <p className={`text-xs ${color === 'green' ? 'text-green-600 dark:text-green-500' :
                            color === 'blue' ? 'text-blue-600 dark:text-blue-500' :
                              color === 'red' ? 'text-red-600 dark:text-red-400' :
                                'text-muted-foreground'
                          }`}>{label}</p>
                      </div>
                    ))}
                  </div>
                )}

                {syncResult.message && !syncResult.success && (
                  <Alert variant="destructive">
                    <AlertDescription className="text-xs">{syncResult.message}</AlertDescription>
                  </Alert>
                )}
              </div>

              {/* Items list */}
              {syncResult.results && syncResult.results.length > 0 && (
                <div className="rounded-lg border overflow-hidden">
                  <div className="bg-muted/40 px-4 py-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">{syncResult.results.length} eventos registrados</span>
                    <span className="text-xs text-muted-foreground">Memória do navegador · limpo ao fechar a aba</span>
                  </div>

                  <div className="divide-y max-h-96 overflow-y-auto">
                    {(showAllResults ? syncResult.results : syncResult.results.slice(0, PREVIEW_COUNT)).map((item, idx) => (
                      <SyncResultRow key={idx} item={item} />
                    ))}
                  </div>

                  {syncResult.results.length > PREVIEW_COUNT && (
                    <div className="bg-muted/40 px-4 py-2 border-t">
                      <Button variant="ghost" size="sm" className="w-full text-xs text-muted-foreground gap-1" onClick={() => setShowAllResults(v => !v)}>
                        {showAllResults
                          ? <><ChevronUp className="h-3.5 w-3.5" />Mostrar menos</>
                          : <><ChevronDown className="h-3.5 w-3.5" />Mostrar todos os {syncResult.results.length} eventos</>}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default StoreMapping;