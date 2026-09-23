import { useState, useEffect } from 'react';
import { useGsapStagger } from '@/hooks/use-gsap';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Loader2, CheckCircle2, Zap, Copy, ExternalLink,
  AlertTriangle, CheckCheck, Plug, XCircle,
} from 'lucide-react';
import { ECOMMERCE_FIELDS, type EcommercePlatform } from '@/types';
import { usePlatformSettingsStore } from '@/store/platformSettings';
import { useToast } from '@/hooks/use-toast';
import { useAuthStore } from '@/store/auth';
import { getIntegrations, updateIntegration, patchIntegration, testEcommerceConnection, type StoreItem } from '@/services/api';

// Plataformas que suportam registro automático de webhook.
// MaxData fica de fora: não tem nenhuma API (nem painel) de webhooks — a
// sincronização é sempre via "Sincronizar Catálogo" (manual ou agendada).
const AUTO_REGISTER_SUPPORT: Record<string, boolean> = {
  shopify: true, woocommerce: true, nuvemshop: true, vtex: true, tray: true, olist: true, maxdata: false, custom: false,
};

// Plataformas que suportam teste de conexão
const TEST_CONNECTION_SUPPORT: Record<string, boolean> = {
  shopify: true, woocommerce: true, nuvemshop: true, vtex: true, tray: true, olist: true, maxdata: true, custom: false,
};

// Documentação manual por plataforma
const MANUAL_DOCS: Record<string, { label: string; url: string }> = {
  shopify:     { label: 'Shopify Webhooks Docs',     url: 'https://help.shopify.com/en/manual/orders/notifications/webhooks' },
  woocommerce: { label: 'WooCommerce Webhooks Docs', url: 'https://woocommerce.com/document/webhooks/' },
  nuvemshop:   { label: 'Nuvemshop API Docs',        url: 'https://tiendanube.github.io/api-documentation/resources/webhook' },
  vtex:        { label: 'VTEX Hook API Docs',        url: 'https://developers.vtex.com/docs/guides/orders-feed' },
  tray:        { label: 'Tray Webhooks Docs',        url: 'https://developers.tray.com.br/webhooks' },
  olist:       { label: 'Olist Ecommerce API Docs',   url: 'https://developers.vnda.com.br/guides/integracoes/webhooks/' },
};

interface RegisterResult {
  success: boolean;
  message: string;
  webhook_url?: string;
  mode?: 'register' | 'check';
  details?: Array<{ topic?: string; event?: string; trigger?: string; status: string; id?: string | number; detail?: unknown; httpStatus?: number; url?: string }>;
  extra?: Array<{ event: string; status: string; id?: string | number; url?: string }>;
}

const EcommerceConfig = () => {
  const { token: authToken } = useAuthStore();
  const { isPlatformEnabled } = usePlatformSettingsStore();
  const [platform, setPlatform]           = useState<EcommercePlatform | ''>('');
  const [config, setConfig]               = useState<Record<string, string>>({});
  const [ecommerceActive, setEcommerceActive] = useState(false);
  const [webhookToken, setWebhookToken]   = useState('');
  const [loading, setLoading]             = useState(true);
  const [saving, setSaving]               = useState(false);
  const [registering, setRegistering]     = useState(false);
  const [checking, setChecking]           = useState(false);
  const [registerResult, setRegisterResult] = useState<RegisterResult | null>(null);
  const [showResult, setShowResult]       = useState(false);

  // Estado do teste de conexão
  const [testing, setTesting]             = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [connectionMsg, setConnectionMsg] = useState('');

  const [ecommerceStores, setEcommerceStores] = useState<StoreItem[]>([]);

  const { toast } = useToast();

  useEffect(() => {
    getIntegrations()
      .then((res) => {
        const i = (res as any).integration;
        if (i) {
          setPlatform(i.ecommerce_platform || '');
          const savedConfig = i.ecommerce_config || {};
          setConfig(savedConfig);
          setEcommerceActive(i.ecommerce_active || false);
          setWebhookToken(i.webhook_token || '');
          // Restore last known connection status
          if (savedConfig._connection_status) {
            setConnectionStatus(savedConfig._connection_status as 'success' | 'error');
            setConnectionMsg(savedConfig._connection_msg || '');
          }
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const fields = platform ? ECOMMERCE_FIELDS[platform].fields : [];
  const webhookUrl = webhookToken
    ? `${window.location.origin}/webhook?token=${webhookToken}`
    : '';

  const handleSave = async () => {
    if (!platform) {
      toast({ title: 'Selecione uma plataforma', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      // Strip internal UI-only fields before persisting
      const { _connection_status, _connection_msg, ...configToSave } = config;
      await updateIntegration({ ecommerce_platform: platform, ecommerce_config: { ...configToSave, _connection_status: connectionStatus !== 'idle' ? connectionStatus : undefined, _connection_msg: connectionMsg || undefined } });
      toast({ title: 'Configuração salva com sucesso!' });
    } catch (err: unknown) {
      toast({ title: 'Erro ao salvar', description: err instanceof Error ? err.message : '', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    try {
      await patchIntegration({ ecommerce_active: !ecommerceActive });
      setEcommerceActive(!ecommerceActive);
      toast({ title: ecommerceActive ? 'E-commerce desativado' : 'E-commerce ativado' });
    } catch (err: unknown) {
      toast({ title: 'Erro ao atualizar', description: err instanceof Error ? err.message : '', variant: 'destructive' });
    }
  };

  // ── Teste de conexão ────────────────────────────────────────────────────────
  const handleTest = async () => {
    if (!platform) {
      toast({ title: 'Selecione uma plataforma', variant: 'destructive' });
      return;
    }

    const requiredFields = ECOMMERCE_FIELDS[platform as EcommercePlatform]?.fields || [];
    const missing = requiredFields.filter(f => !config[f.key]?.trim());
    if (missing.length > 0) {
      toast({
        title: 'Campos obrigatórios',
        description: `Preencha: ${missing.map(f => f.label).join(', ')}`,
        variant: 'destructive',
      });
      return;
    }

    setTesting(true);
    setConnectionStatus('idle');
    setConnectionMsg('');

    try {
      const { _connection_status: _s, _connection_msg: _m, ...configToTest } = config;
      const result = await testEcommerceConnection(platform, configToTest);
      if (result.success) {
        const msg = result.message || 'Conexão estabelecida com sucesso!';
        setConnectionStatus('success');
        setConnectionMsg(msg);
        setConfig((prev) => {
          const updated = { ...prev, _connection_status: 'success', _connection_msg: msg };
          // Auto-persist so status survives page reload without requiring manual Save
          updateIntegration({ ecommerce_platform: platform, ecommerce_config: updated }).catch(() => {});
          return updated;
        });
        if (result.stores && result.stores.length > 0) setEcommerceStores(result.stores);
        toast({ title: '✅ Conexão bem-sucedida!', description: result.store ? `Loja: ${result.store}` : undefined });
      } else {
        const msg = result.message || 'Falha na conexão.';
        setConnectionStatus('error');
        setConnectionMsg(msg);
        setConfig((prev) => {
          const updated = { ...prev, _connection_status: 'error', _connection_msg: msg };
          updateIntegration({ ecommerce_platform: platform, ecommerce_config: updated }).catch(() => {});
          return updated;
        });
        toast({ title: 'Falha na conexão', description: result.message, variant: 'destructive' });
      }
    } catch (err: unknown) {
      setConnectionStatus('error');
      const msg = err instanceof Error ? err.message : 'Erro desconhecido';
      setConnectionMsg(msg);
      setConfig((prev) => {
        const updated = { ...prev, _connection_status: 'error', _connection_msg: msg };
        updateIntegration({ ecommerce_platform: platform, ecommerce_config: updated }).catch(() => {});
        return updated;
      });
      toast({ title: 'Erro ao testar', description: msg, variant: 'destructive' });
    } finally {
      setTesting(false);
    }
  };

  const handleRegisterWebhook = async () => {
    setRegistering(true);
    setRegisterResult(null);
    try {
      const token = authToken || '';
      const res = await fetch('/register-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      });
      const data: RegisterResult = await res.json();
      setRegisterResult(data);
      setShowResult(true);
      if (data.success) {
        toast({ title: '✅ Webhook registrado com sucesso!' });
      } else {
        toast({ title: 'Atenção', description: data.message, variant: 'destructive' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro desconhecido';
      setRegisterResult({ success: false, message: msg });
      setShowResult(true);
      toast({ title: 'Erro ao registrar webhook', description: msg, variant: 'destructive' });
    } finally {
      setRegistering(false);
    }
  };

  const handleCheckWebhooks = async () => {
    setChecking(true);
    setRegisterResult(null);
    try {
      const token = authToken || '';
      const res = await fetch('/register-webhook', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data: RegisterResult = await res.json();
      setRegisterResult(data);
      setShowResult(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro desconhecido';
      setRegisterResult({ success: false, message: msg });
      setShowResult(true);
      toast({ title: 'Erro ao verificar webhooks', description: msg, variant: 'destructive' });
    } finally {
      setChecking(false);
    }
  };

  const copyWebhookUrl = () => {
    if (webhookUrl) { navigator.clipboard.writeText(webhookUrl); toast({ title: 'URL copiada!' }); }
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: 'URL copiada!' });
  };

  const containerRef = useGsapStagger<HTMLDivElement>([loading], { stagger: 0.1, y: 20, delay: 0.05 });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const supportsAutoRegister = platform ? AUTO_REGISTER_SUPPORT[platform] : false;
  const supportsTest = platform ? TEST_CONNECTION_SUPPORT[platform] : false;

  return (
    <div ref={containerRef} className="space-y-6">
      <div style={{ opacity: 0 }}>
        <h1 className="text-2xl font-bold">E-commerce</h1>
        <p className="text-muted-foreground">Configure sua plataforma e registre o webhook automaticamente</p>
      </div>

      {/* Configuração da plataforma */}
      <Card style={{ opacity: 0 }}>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle>Plataforma</CardTitle>
              <CardDescription>Selecione e configure sua plataforma de e-commerce</CardDescription>
            </div>
            {platform && (
              <div className="flex items-center gap-2">
                {connectionStatus === 'success' && (
                  <Badge variant={"outline" as const} className="border-success text-success gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Conectado
                  </Badge>
                )}
                {connectionStatus === 'error' && (
                  <Badge variant={"destructive" as const} className="gap-1">
                    <XCircle className="h-3 w-3" /> Falha
                  </Badge>
                )}
                <Button variant={(ecommerceActive ? 'default' : 'outline') as BadgeVariant} size="sm" onClick={handleToggle}>
                  {ecommerceActive ? 'Ativado' : 'Desativado'}
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Plataforma de E-commerce</Label>
            <Select
              value={platform}
              onValueChange={(v) => {
                setPlatform(v as EcommercePlatform);
                // Preserva campos internos (começam com _) ao trocar de plataforma
                // para não apagar _store_mappings, _ecommerce_stores etc.
                setConfig((prev) => {
                  const preserved: Record<string, string> = {};
                  for (const key of Object.keys(prev)) {
                    if (key.startsWith('_')) preserved[key] = prev[key];
                  }
                  return preserved;
                });
                setConnectionStatus('idle');
                setConnectionMsg('');
              }}
            >
              <SelectTrigger><SelectValue placeholder="Selecione a plataforma" /></SelectTrigger>
              <SelectContent>
                {Object.entries(ECOMMERCE_FIELDS)
                  .filter(([key]) => isPlatformEnabled(key))
                  .map(([key, val]) => (
                    <SelectItem key={key} value={key}>{val.label}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {fields.map((field) => (
            <div key={field.key} className="space-y-2">
              <Label>{field.label}</Label>
              <Input
                type={field.type || 'text'}
                value={config[field.key] || ''}
                onChange={(e) => {
                  setConfig(prev => ({ ...prev, [field.key]: e.target.value, _connection_status: '', _connection_msg: '' }));
                  setConnectionStatus('idle');
                  setConnectionMsg('');
                }}
              />
            </div>
          ))}

          {platform && (
            <div className="flex flex-wrap gap-3 pt-2">
              {/* Botão Testar Conexão */}
              {supportsTest && (
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={testing || saving}
                  className={
                    connectionStatus === 'success'
                      ? 'border-green-500 text-green-600 hover:bg-green-50 dark:hover:bg-green-950'
                      : connectionStatus === 'error'
                      ? 'border-destructive text-destructive hover:bg-destructive/10'
                      : ''
                  }
                >
                  {testing ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Testando...</>
                  ) : connectionStatus === 'success' ? (
                    <><CheckCircle2 className="mr-2 h-4 w-4 text-green-500" />Conexão OK</>
                  ) : connectionStatus === 'error' ? (
                    <><XCircle className="mr-2 h-4 w-4" />Falha — Testar novamente</>
                  ) : (
                    <><Plug className="mr-2 h-4 w-4" />Testar Conexão</>
                  )}
                </Button>
              )}

              {/* Botão Salvar */}
              <Button onClick={handleSave} disabled={saving || testing}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Salvar
              </Button>
            </div>
          )}

          {/* Mensagem de status da conexão — só aparece após testar */}
          {connectionStatus !== 'idle' && connectionMsg && (
            <p className={`text-xs mt-1 ${connectionStatus === 'success' ? 'text-green-500' : 'text-destructive'}`}>
              {connectionMsg}
            </p>
          )}

          {/* Lista de lojas encontradas após teste bem-sucedido */}
          {connectionStatus === 'success' && ecommerceStores.length > 0 && (
            <div className="mt-3 rounded-lg border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Lojas encontradas</p>
              <ul className="space-y-1">
                {ecommerceStores.map(s => (
                  <li key={s.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="truncate">{s.name}</span>
                    <code className="text-xs bg-muted px-1 rounded ml-auto shrink-0">#{s.id}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Seção de webhook */}
      {platform && webhookToken && (
        <Card>
          <CardHeader>
            <CardTitle>Webhook do E-commerce</CardTitle>
            <CardDescription>
              URL e token exclusivos para receber eventos da sua loja
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>URL do Webhook <span className="text-xs text-muted-foreground font-normal ml-1">(exclusiva do e-commerce)</span></Label>
              <div className="flex gap-2">
                <Input value={webhookUrl} readOnly className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={copyWebhookUrl}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Cole esta URL no painel do seu e-commerce. Token e URL do chatbot ficam em <strong>Configuração de Chatbot</strong>.
              </p>
            </div>

            {supportsAutoRegister ? (
              <div className="space-y-3">
                <Alert>
                  <Zap className="h-4 w-4" />
                  <AlertDescription>
                    Clique em <strong>Registrar Automaticamente</strong> para configurar o webhook
                    direto no painel da {ECOMMERCE_FIELDS[platform as EcommercePlatform]?.label}.
                    As credenciais salvas serão usadas para autenticar.
                  </AlertDescription>
                </Alert>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={handleRegisterWebhook} disabled={registering || checking} className="w-full sm:w-auto">
                    {registering
                      ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Registrando...</>
                      : <><Zap className="mr-2 h-4 w-4" />Registrar Webhook Automaticamente</>
                    }
                  </Button>
                  {platform === 'nuvemshop' && (
                    <Button variant="outline" onClick={handleCheckWebhooks} disabled={registering || checking} className="w-full sm:w-auto">
                      {checking
                        ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Verificando...</>
                        : <><CheckCircle2 className="mr-2 h-4 w-4" />Verificar webhooks registrados</>
                      }
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Registro automático não disponível para plataformas customizadas.
                  Copie a URL acima e configure manualmente no painel da sua plataforma.
                </AlertDescription>
              </Alert>
            )}

            {MANUAL_DOCS[platform] && (
              <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground" asChild>
                <a href={MANUAL_DOCS[platform].url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3 w-3" />
                  {MANUAL_DOCS[platform].label}
                </a>
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Modal de resultado do registro */}
      <Dialog open={showResult} onOpenChange={setShowResult}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {registerResult?.mode === 'check'
                ? <><CheckCircle2 className="h-5 w-5 text-[#2f7bb9]" /> Verificação de Webhooks</>
                : registerResult?.success
                  ? <><CheckCheck className="h-5 w-5 text-green-500" /> Webhook Registrado</>
                  : <><AlertTriangle className="h-5 w-5 text-destructive" /> Resultado do Registro</>
              }
            </DialogTitle>
          </DialogHeader>

          {registerResult && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{registerResult.message}</p>

              {registerResult.webhook_url && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">URL {registerResult.mode === 'check' ? 'esperada' : 'registrada'}:</p>
                  <code className="text-xs bg-muted rounded p-2 block break-all">
                    {registerResult.webhook_url}
                  </code>
                </div>
              )}

              {registerResult.details && registerResult.details.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {registerResult.mode === 'check' ? 'Status por evento' : 'Detalhes por evento'}
                  </p>
                  <div className="space-y-1">
                    {registerResult.details.map((d, i) => {
                      const label = d.topic || d.event || d.trigger || `evento ${i + 1}`;
                      const isOk = d.status === 'created' || d.status === 'already_exists' || d.status === 'registered';
                      const isWarn = d.status === 'unsupported' || d.status === 'wrong_url';
                      const isManual = d.status === 'manual';
                      const statusLabel: Record<string, string> = {
                        already_exists: 'já existe',
                        unsupported: 'não suportado',
                        registered: 'registrado',
                        missing: 'não encontrado',
                        wrong_url: 'URL diferente',
                        manual: 'configurar manualmente',
                      };
                      return (
                        <div key={i} className="py-1 border-b last:border-0">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-mono text-xs">{label}</span>
                            <Badge
                              variant={(isOk ? 'outline' : (isWarn || isManual) ? 'secondary' : 'destructive') as BadgeVariant}
                              className={isOk ? 'border-success text-success text-xs' : (isWarn || isManual) ? 'text-xs text-yellow-600 dark:text-yellow-400' : 'text-xs'}
                            >
                              {statusLabel[d.status] ?? d.status}
                              {d.id ? ` #${d.id}` : ''}
                            </Badge>
                          </div>
                          {d.status === 'error' && d.detail && (
                            <p className="text-xs text-destructive/80 mt-0.5 font-mono break-all">
                              {d.httpStatus ? `HTTP ${d.httpStatus} — ` : ''}{typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail).slice(0, 120)}
                            </p>
                          )}
                          {d.status === 'wrong_url' && d.url && (
                            <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-0.5 break-all">registrado em: {d.url}</p>
                          )}
                          {isManual && d.url && (
                            <div className="flex items-center gap-1.5 mt-1">
                              <code className="flex-1 text-xs bg-muted rounded px-1.5 py-1 break-all">{d.url}</code>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0"
                                onClick={() => copyText(d.url as string)}
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {registerResult.extra && registerResult.extra.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Eventos extras registrados</p>
                  <div className="space-y-1">
                    {registerResult.extra.map((d, i) => (
                      <div key={i} className="flex items-center justify-between text-sm py-1 border-b last:border-0">
                        <span className="font-mono text-xs">{d.event}</span>
                        <Badge variant={'secondary' as BadgeVariant} className="text-xs text-muted-foreground">
                          extra {d.id ? `#${d.id}` : ''}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!registerResult.success && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    Verifique se as credenciais salvas estão corretas e se sua loja está acessível.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default EcommerceConfig;
