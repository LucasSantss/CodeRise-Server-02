import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import type { BadgeVariant } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2, MessageSquare, ShoppingCart, Info, Webhook } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { getPlatformSettings, patchPlatformSettings, getErrorWebhookSettings, patchErrorWebhookSettings } from '@/services/api';
import { usePlatformSettingsStore, CHATBOT_PLATFORMS, ECOMMERCE_PLATFORMS } from '@/store/platformSettings';

const CHATBOT_LABELS: Record<string, string> = {
  suri:          'Suri',
  evolution_api: 'Evolution API',
  kommo:         'Kommo',
  take_blip:     'Take Blip',
  manychat:      'ManyChat',
  weni:          'Weni',
};

const ECOMMERCE_LABELS: Record<string, string> = {
  shopify:     'Shopify',
  woocommerce: 'WooCommerce',
  tray:        'Tray',
  nuvemshop:   'Nuvemshop',
  olist:       'Olist',
  vtex:        'VTEX',
  maxdata:     'MaxData',
  custom:      'Customizada',
};

const AdminSettings = () => {
  const [platforms, setPlatforms] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookLoading, setWebhookLoading] = useState(true);
  const [webhookSaving, setWebhookSaving] = useState(false);
  const { toast } = useToast();
  const { setSettings } = usePlatformSettingsStore();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getPlatformSettings();
      setPlatforms(res.platforms || {});
    } catch (err: unknown) {
      toast({ title: 'Erro ao carregar configurações', description: err instanceof Error ? err.message : '', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadWebhook = useCallback(async () => {
    setWebhookLoading(true);
    try {
      const res = await getErrorWebhookSettings();
      setWebhookUrl(res.webhook_url || '');
    } catch (err: unknown) {
      toast({ title: 'Erro ao carregar webhook', description: err instanceof Error ? err.message : '', variant: 'destructive' });
    } finally {
      setWebhookLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); loadWebhook(); }, [load, loadWebhook]);

  const handleSaveWebhook = async () => {
    setWebhookSaving(true);
    try {
      const res = await patchErrorWebhookSettings(webhookUrl.trim());
      setWebhookUrl(res.webhook_url || '');
      toast({ title: '✅ Webhook salvo com sucesso' });
    } catch (err: unknown) {
      toast({ title: 'Erro ao salvar webhook', description: err instanceof Error ? err.message : '', variant: 'destructive' });
    } finally {
      setWebhookSaving(false);
    }
  };

  const isEnabled = (key: string) => platforms[key] !== false && platforms[key] !== "false"; // default true if not set

  const handleToggle = async (key: string, value: boolean) => {
    setSaving(key);
    try {
      const res = await patchPlatformSettings({ [key]: value });
      const updated = res.platforms || {};
      setPlatforms(updated);
      setSettings(updated); // sync sidebar immediately
      toast({ title: `${value ? '✅' : '🚫'} ${CHATBOT_LABELS[key] || ECOMMERCE_LABELS[key] || key} ${value ? 'habilitada' : 'desabilitada'}` });
    } catch (err: unknown) {
      toast({ title: 'Erro ao salvar', description: err instanceof Error ? err.message : '', variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  const PlatformRow = ({ platformKey, label }: { platformKey: string; label: string }) => {
    const enabled = isEnabled(platformKey);
    const isSaving = saving === platformKey;
    return (
      <div className="flex items-center justify-between py-3">
        <div className="flex items-center gap-3">
          <div className={`h-2 w-2 rounded-full flex-shrink-0 ${enabled ? 'bg-emerald-400' : 'bg-muted-foreground/30'}`} />
          <span className="text-sm font-medium">{label}</span>
        </div>
        <div className="flex items-center gap-3">
          <Badge
            variant={((enabled ? 'outline' : 'secondary') as 'outline' | 'secondary') as BadgeVariant}
            className={`text-xs ${enabled ? 'border-success text-success' : ''}`}
          >
            {enabled ? 'Habilitada' : 'Desabilitada'}
          </Badge>
          {isSaving ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch
              checked={enabled}
              onCheckedChange={(v) => handleToggle(platformKey, v)}
              disabled={saving !== null}
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Configurações</h1>
        <p className="text-muted-foreground">Gerencie as plataformas de integração disponíveis</p>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          Desabilite plataformas individualmente. Plataformas desabilitadas não aparecem como opção
          para nenhum usuário da plataforma.
        </AlertDescription>
      </Alert>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-4">

          {/* Chatbot */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-[#56388e]/10 border border-[#56388e]/20 flex items-center justify-center flex-shrink-0">
                  <MessageSquare className="h-4.5 w-4.5 text-[#56388e]" style={{ height: '1.05rem', width: '1.05rem' }} />
                </div>
                <div>
                  <CardTitle className="text-base">Plataformas de Chatbot</CardTitle>
                  <CardDescription className="text-xs mt-0.5">
                    Controle quais chatbots os usuários podem configurar
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="divide-y divide-border/50">
                {CHATBOT_PLATFORMS.map((key, i) => (
                  <PlatformRow key={key} platformKey={key} label={CHATBOT_LABELS[key]} />
                ))}
              </div>
            </CardContent>
          </Card>

          {/* E-commerce */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-[#2f7bb9]/10 border border-[#2f7bb9]/20 flex items-center justify-center flex-shrink-0">
                  <ShoppingCart className="h-4.5 w-4.5 text-[#2f7bb9]" style={{ height: '1.05rem', width: '1.05rem' }} />
                </div>
                <div>
                  <CardTitle className="text-base">Plataformas de E-commerce</CardTitle>
                  <CardDescription className="text-xs mt-0.5">
                    Controle quais lojas os usuários podem conectar
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="divide-y divide-border/50">
                {ECOMMERCE_PLATFORMS.map((key) => (
                  <PlatformRow key={key} platformKey={key} label={ECOMMERCE_LABELS[key]} />
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Webhook de erros */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-destructive/10 border border-destructive/20 flex items-center justify-center flex-shrink-0">
                  <Webhook className="h-4.5 w-4.5 text-destructive" style={{ height: '1.05rem', width: '1.05rem' }} />
                </div>
                <div>
                  <CardTitle className="text-base">Webhook de Notificações de Erro</CardTitle>
                  <CardDescription className="text-xs mt-0.5">
                    Toda notificação de erro enviada aos admins também é disparada em JSON para esta URL
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {webhookLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    type="url"
                    placeholder="https://seu-sistema.com/webhook"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    disabled={webhookSaving}
                  />
                  <Button onClick={handleSaveWebhook} disabled={webhookSaving}>
                    {webhookSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salvar'}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

        </div>
      )}
    </div>
  );
};

export default AdminSettings;
