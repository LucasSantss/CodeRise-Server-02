import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { BadgeVariant } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, Loader2 } from 'lucide-react';
import { getIntegrations } from '@/services/api';
import type { UserIntegration } from '@/types';

const AdminIntegrations = () => {
  const [integrations, setIntegrations] = useState<(UserIntegration & { user_name?: string; user_email?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [platformFilter, setPlatformFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getIntegrations();
      setIntegrations((res as any).integrations || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = integrations.filter((i) => {
    const matchSearch =
      !search ||
      (i.user_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (i.user_email || '').toLowerCase().includes(search.toLowerCase());
    const matchPlatform = platformFilter === 'all' || i.ecommerce_platform === platformFilter;
    return matchSearch && matchPlatform;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Integrações</h1>
        <p className="text-muted-foreground">Todas as integrações configuradas na plataforma</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex items-center gap-2 flex-1">
              <Search className="h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por usuário..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="border-0 bg-transparent px-0 focus-visible:ring-0"
              />
            </div>
            <Select value={platformFilter} onValueChange={setPlatformFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Plataforma" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas</SelectItem>
                <SelectItem value="shopify">Shopify</SelectItem>
                <SelectItem value="woocommerce">WooCommerce</SelectItem>
                <SelectItem value="tray">Tray</SelectItem>
                <SelectItem value="nuvemshop">Nuvemshop</SelectItem>
                <SelectItem value="vtex">VTEX</SelectItem>
                <SelectItem value="maxdata">MaxData</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Usuário</TableHead>
                <TableHead>Suri</TableHead>
                <TableHead>E-commerce</TableHead>
                <TableHead>Plataforma</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={4} className="text-center py-8"><Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" /></TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">Nenhuma integração encontrada</TableCell></TableRow>
              ) : filtered.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <div className="font-medium">{i.user_name}</div>
                    <div className="text-xs text-muted-foreground">{i.user_email}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={((i.suri_active ? 'outline' : 'secondary') as 'outline' | 'secondary') as BadgeVariant} className={i.suri_active ? 'border-success text-success' : ''}>
                      {i.suri_active ? 'Ativa' : 'Inativa'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={((i.ecommerce_active ? 'outline' : 'secondary') as 'outline' | 'secondary') as BadgeVariant} className={i.ecommerce_active ? 'border-success text-success' : ''}>
                      {i.ecommerce_active ? 'Ativo' : 'Inativo'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {i.ecommerce_platform ? (
                      <Badge variant="secondary">{i.ecommerce_platform}</Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
};

export default AdminIntegrations;
