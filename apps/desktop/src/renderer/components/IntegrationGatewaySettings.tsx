import { useEffect, useState } from "react";
import { KeyRound, PlugZap, ShieldX } from "lucide-react";

import type { MessageKey } from "@app/i18n";
import type {
  IntegrationClient,
  IntegrationGatewayStatus,
  IntegrationPairingResult
} from "../../shared/ipc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function IntegrationGatewaySettings({ t }: { t: (key: MessageKey) => string }) {
  const [gateway, setGateway] = useState<IntegrationGatewayStatus | null>(null);
  const [clients, setClients] = useState<IntegrationClient[]>([]);
  const [clientType, setClientType] = useState<"chrome-extension" | "obsidian-plugin">("chrome-extension");
  const [displayName, setDisplayName] = useState("");
  const [pairing, setPairing] = useState<IntegrationPairingResult | null>(null);

  useEffect(() => {
    void Promise.all([
      window.app.integrations.getGatewayStatus(),
      window.app.integrations.listClients()
    ]).then(([nextGateway, nextClients]) => {
      setGateway(nextGateway);
      setClients(nextClients);
    });
  }, []);

  async function createPairing() {
    const result = await window.app.integrations.createPairing({
      clientType,
      displayName: displayName.trim() || (clientType === "chrome-extension"
        ? t("settings.integrations.chromeExtension")
        : t("settings.integrations.obsidianPlugin"))
    });
    setPairing(result);
    setClients(await window.app.integrations.listClients());
  }

  async function revoke(id: string) {
    await window.app.integrations.revokeClient(id);
    setClients(await window.app.integrations.listClients());
  }

  return (
    <section className="grid gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <PlugZap className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="font-semibold text-slate-950 dark:text-slate-50">{t("settings.integrations.gateway")}</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t("settings.dashboard.navigation.connectionsDescription")}</p>
        </div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="font-medium text-slate-900 dark:text-slate-100">
          {t("settings.integrations.gatewayStatus")}: {gateway ? t(`settings.integrations.states.${gateway.state}` as MessageKey) : t("shell.states.loading")}
        </div>
        {gateway?.baseUrl ? <code className="mt-1 block text-slate-600 dark:text-slate-300">{gateway.baseUrl}</code> : null}
      </div>
      <div className="grid gap-3 md:grid-cols-[12rem_1fr_auto] md:items-end">
        <div className="grid gap-2">
          <Label htmlFor="integrationClientType">{t("settings.integrations.clientType")}</Label>
          <select
            id="integrationClientType"
            className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
            value={clientType}
            onChange={(event) => setClientType(event.target.value as typeof clientType)}
          >
            <option value="chrome-extension">{t("settings.integrations.chromeExtension")}</option>
            <option value="obsidian-plugin">{t("settings.integrations.obsidianPlugin")}</option>
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="integrationDisplayName">{t("settings.integrations.displayName")}</Label>
          <Input id="integrationDisplayName" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </div>
        <Button type="button" onClick={() => void createPairing()} disabled={gateway?.state !== "ready"}>
          <KeyRound className="h-4 w-4" aria-hidden="true" />
          {t("settings.integrations.createPairing")}
        </Button>
      </div>
      {pairing ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-sm font-medium text-amber-950 dark:text-amber-100">{t("integrations.clientId")}</p>
          <code className="mt-2 block break-all rounded bg-white p-2 text-xs dark:bg-slate-950">{pairing.clientId}</code>
          <p className="text-sm font-medium text-amber-950 dark:text-amber-100">{t("settings.integrations.pairingToken")}</p>
          <code className="mt-2 block break-all rounded bg-white p-2 text-xs dark:bg-slate-950">{pairing.token}</code>
          <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">{t("settings.integrations.pairingTokenWarning")}</p>
        </div>
      ) : null}
      <div className="grid gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("settings.integrations.authorizedClients")}</h3>
        {clients.length === 0 ? <p className="text-sm text-slate-500">{t("settings.integrations.noClients")}</p> : clients.map((client) => (
          <div key={client.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
            <div>
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{client.displayName}</div>
              <div className="text-xs text-slate-500">{client.clientType} · {client.status}</div>
            </div>
            {client.status === "paired" ? (
              <Button type="button" className="bg-white text-slate-800 hover:bg-slate-100 dark:bg-slate-950 dark:text-slate-200" onClick={() => void revoke(client.id)}>
                <ShieldX className="h-4 w-4" aria-hidden="true" />
                {t("settings.integrations.revoke")}
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
