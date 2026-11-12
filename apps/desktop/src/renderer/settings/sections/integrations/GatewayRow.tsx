import { useState } from "react";
import { Copy, ShieldX } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";

import type {
  IntegrationClient,
  IntegrationGatewayStatus,
  IntegrationPairingResult
} from "../../../../shared/ipc";
import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Skeleton } from "../../../components/ui/skeleton";
import { PageRow } from "../../PageRow";
import { ReadProblem, SelectControl, StatusLine, type StatusTone } from "../../SettingControls";
import { useSettings } from "../../settings-context";
import { labelOf, helpOf } from "../../settings-model";
import { clientKindLabel, gatewayMeta } from "./integrations-model";
import type { GatewayHandle } from "./use-integrations-data";

type ClientType = "chrome-extension" | "obsidian-plugin";

const stateTone: Readonly<Record<IntegrationGatewayStatus["state"], StatusTone>> = {
  ready: "ok",
  starting: "working",
  stopped: "idle",
  failed: "warn"
};

/** "3 days ago", "today": how long since a client was paired, in the person's language. */
function pairedSince(t: Translator, client: IntegrationClient, now: Date): string {
  const days = Math.max(
    0,
    Math.floor((now.getTime() - new Date(client.createdAt).getTime()) / 86_400_000)
  );
  const since =
    days === 0
      ? t("settingsIntegrations.gateway.today")
      : new Intl.RelativeTimeFormat(t.locale, { numeric: "always" }).format(-days, "day");
  return t("settingsIntegrations.gateway.pairedSince", { values: { since } });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The local gateway and the apps paired with it (Settings › Integrations › Local connection), as a
 * page that opens in the row: the address the gateway listens on (this Mac only), the paired apps
 * with "Revoke" (asked first, in the row), and "Pair an app…", which shows the pairing token once.
 * The gateway answers only paired apps; the token is never kept after the person is done with it.
 */
export function GatewayRow({
  entry,
  handle,
  initialOpen = false
}: {
  entry: SettingEntryV2;
  handle: GatewayHandle;
  /** The row starts open (the screens tool shows the address and the paired apps this way). */
  initialOpen?: boolean;
}) {
  const { t } = useSettings();
  const { gateway } = handle;
  // A read that failed opens the row by itself, so its sentence and its retry are not hidden.
  const [opened, setOpened] = useState<boolean | null>(null);
  const open = opened ?? (initialOpen || gateway.status === "failed");
  // A failed read has no summary: the open row says it once, with its retry.
  const meta =
    gateway.status === "ready" ? gatewayMeta(t, gateway.value.status, gateway.value.clients) : null;

  return (
    <PageRow
      id={entry.id}
      label={labelOf(t, entry)}
      help={helpOf(t, entry)}
      meta={
        meta ?? (gateway.status === "loading" ? <Skeleton className="h-3.5 w-24" /> : undefined)
      }
      open={open}
      onOpenChange={setOpened}
      bodyClassName="pb-4"
    >
      {gateway.status === "loading" ? (
        <div className="grid gap-2">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-10 w-full max-w-[34rem]" />
        </div>
      ) : gateway.status === "failed" ? (
        <ReadProblem
          t={t}
          message={t("settingsIntegrations.gateway.readFailed")}
          onRetry={handle.reload}
        />
      ) : (
        <GatewayPage
          t={t}
          gateway={gateway.value.status}
          clients={gateway.value.clients}
          reload={handle.reload}
        />
      )}
    </PageRow>
  );
}

function GatewayPage({
  t,
  gateway,
  clients,
  reload
}: {
  t: Translator;
  gateway: IntegrationGatewayStatus;
  clients: IntegrationClient[];
  reload: () => void;
}) {
  const [copied, setCopied] = useState<"address" | "token" | "id" | "failed" | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [failed, setFailed] = useState<"revoke" | "pair" | null>(null);
  const [pairing, setPairing] = useState<"closed" | "form" | "working">("closed");
  const [clientType, setClientType] = useState<ClientType>("chrome-extension");
  const [name, setName] = useState("");
  const [result, setResult] = useState<IntegrationPairingResult | null>(null);
  const now = new Date();
  const paired = clients.filter((client) => client.status === "paired");

  const copy = async (text: string, what: "address" | "token" | "id") =>
    setCopied((await copyText(text)) ? what : "failed");

  const revoke = async (id: string) => {
    setFailed(null);
    try {
      await window.app.integrations.revokeClient(id);
      setAsking(null);
      reload();
    } catch {
      setFailed("revoke");
    }
  };

  const pair = async () => {
    setPairing("working");
    setFailed(null);
    try {
      const displayName =
        name.trim() ||
        t(
          clientType === "chrome-extension"
            ? "settingsIntegrations.gateway.kinds.chromeExtension"
            : "settingsIntegrations.gateway.kinds.obsidianPlugin"
        );
      setResult(await window.app.integrations.createPairing({ clientType, displayName }));
      setPairing("closed");
      setName("");
      reload();
    } catch {
      setFailed("pair");
      setPairing("form");
    }
  };

  const done = () => {
    setResult(null);
    setCopied(null);
  };

  // The paired apps run to the row's right edge, where every other control aligns; the status, the
  // pairing form and the one-time code keep a reading width.
  return (
    <div className="grid gap-4">
      <div className="grid max-w-[34rem] gap-1.5">
        <StatusLine tone={stateTone[gateway.state]}>
          {t("settingsIntegrations.gateway.statusLine", {
            values: {
              state: t(`settingsIntegrations.gateway.states.${gateway.state}` as MessageKey)
            }
          })}
        </StatusLine>
        {gateway.baseUrl ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs text-muted-foreground">
              {t("settingsIntegrations.gateway.address")}
            </span>
            <code className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">
              {gateway.baseUrl}
            </code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copy(gateway.baseUrl ?? "", "address")}
            >
              <Copy aria-hidden="true" />
              {t("settingsIntegrations.gateway.copy")}
            </Button>
            {copied === "address" ? (
              <span role="status" className="text-xs text-secondary-foreground">
                {t("settingsIntegrations.gateway.copied")}
              </span>
            ) : null}
          </div>
        ) : null}
        <p className="m-0 text-xs text-muted-foreground [text-wrap:pretty]">
          {t("settingsIntegrations.gateway.localOnly")}
        </p>
      </div>

      <div className="grid gap-1">
        <h4 className="m-0 text-sm font-semibold text-foreground">
          {t("settingsIntegrations.gateway.clients")}
        </h4>
        {paired.length === 0 ? (
          <p className="m-0 max-w-[34rem] text-sm text-secondary-foreground [text-wrap:pretty]">
            {t("settingsIntegrations.gateway.noClients")}
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-0 p-0">
            {paired.map((client) => (
              <li
                key={client.id}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border py-3 first:border-t"
              >
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                    {client.displayName}
                  </span>
                  <span className="block text-xs text-secondary-foreground">
                    {t(clientKindLabel(client.clientType))} · {pairedSince(t, client, now)}
                  </span>
                </span>
                {asking === client.id ? (
                  <span role="group" className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-foreground">
                      {t("settingsIntegrations.gateway.revokeAsk", {
                        values: { name: client.displayName }
                      })}
                    </span>
                    <Button
                      variant="secondary"
                      aria-label={`${t("settingsIntegrations.gateway.revoke")}: ${client.displayName}`}
                      onClick={() => void revoke(client.id)}
                    >
                      {t("settingsIntegrations.gateway.revoke")}
                    </Button>
                    <Button variant="ghost" onClick={() => setAsking(null)}>
                      {t("shell.actions.cancel")}
                    </Button>
                  </span>
                ) : (
                  <Button
                    aria-label={`${t("settingsIntegrations.gateway.revoke")}: ${client.displayName}`}
                    onClick={() => setAsking(client.id)}
                  >
                    <ShieldX aria-hidden="true" />
                    {t("settingsIntegrations.gateway.revoke")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {failed === "revoke" ? (
          <StatusLine tone="warn" role="status">
            {t("settingsIntegrations.gateway.revokeFailed")}
          </StatusLine>
        ) : null}
      </div>

      {result ? (
        <div
          role="group"
          aria-label={t("settingsIntegrations.gateway.tokenTitle")}
          className="grid max-w-[34rem] gap-2 rounded-lg bg-warning-soft p-3 text-sm text-foreground"
        >
          <p className="m-0 font-semibold">{t("settingsIntegrations.gateway.tokenTitle")}</p>
          <p className="m-0 [text-wrap:pretty]">{t("settingsIntegrations.gateway.tokenWarning")}</p>
          <SecretLine
            t={t}
            label={t("integrations.clientId")}
            value={result.clientId}
            onCopy={() => void copy(result.clientId, "id")}
          />
          <SecretLine
            t={t}
            label={t("integrations.pairingToken")}
            value={result.token}
            onCopy={() => void copy(result.token, "token")}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={done}>
              {t("settingsIntegrations.gateway.tokenDone")}
            </Button>
            {copied === "token" || copied === "id" ? (
              <span role="status" className="text-xs text-secondary-foreground">
                {t("settingsIntegrations.gateway.copied")}
              </span>
            ) : copied === "failed" ? (
              <span role="status" className="text-xs text-secondary-foreground">
                {t("settingsIntegrations.gateway.copyFailed")}
              </span>
            ) : null}
          </div>
        </div>
      ) : pairing === "closed" ? (
        <div>
          <Button disabled={gateway.state !== "ready"} onClick={() => setPairing("form")}>
            {t("settingsIntegrations.gateway.pair")}
          </Button>
          {gateway.state !== "ready" ? (
            <p className="m-0 mt-1 max-w-[34rem] text-xs text-muted-foreground [text-wrap:pretty]">
              {t(
                gateway.state === "starting"
                  ? "settingsIntegrations.gateway.pairNeedsReady"
                  : "settingsIntegrations.gateway.pairRestart"
              )}
            </p>
          ) : null}
        </div>
      ) : (
        <form
          className="grid max-w-[34rem] gap-3 rounded-lg border border-border bg-surface p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void pair();
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-xs text-secondary-foreground">
              {t("settingsIntegrations.gateway.clientType")}
              <SelectControl<ClientType>
                label={t("settingsIntegrations.gateway.clientType")}
                value={clientType}
                width="13rem"
                onChange={setClientType}
                options={[
                  {
                    value: "chrome-extension",
                    label: t("settingsIntegrations.gateway.kinds.chromeExtension")
                  },
                  {
                    value: "obsidian-plugin",
                    label: t("settingsIntegrations.gateway.kinds.obsidianPlugin")
                  }
                ]}
              />
            </label>
            <label className="grid min-w-0 flex-1 basis-48 gap-1 text-xs text-secondary-foreground">
              {t("settingsIntegrations.gateway.displayName")}
              <Input
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          </div>
          {clientType === "obsidian-plugin" ? (
            <p className="m-0 text-xs text-muted-foreground [text-wrap:pretty]">
              {t("obsidianEditing.scopeHint")}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={pairing === "working"}>
              {t("settingsIntegrations.gateway.createPairing")}
            </Button>
            <Button
              variant="ghost"
              disabled={pairing === "working"}
              onClick={() => setPairing("closed")}
            >
              {t("shell.actions.cancel")}
            </Button>
          </div>
          {failed === "pair" ? (
            <StatusLine tone="warn" role="status">
              {t("settingsIntegrations.gateway.pairFailed")}
            </StatusLine>
          ) : null}
        </form>
      )}
    </div>
  );
}

function SecretLine({
  t,
  label,
  value,
  onCopy
}: {
  t: Translator;
  label: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-secondary-foreground">{label}</span>
      <span className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 rounded-md bg-surface p-2 text-xs text-foreground [overflow-wrap:anywhere]">
          {value}
        </code>
        <Button
          size="sm"
          onClick={onCopy}
          aria-label={`${t("settingsIntegrations.gateway.copy")}: ${label}`}
        >
          <Copy aria-hidden="true" />
          {t("settingsIntegrations.gateway.copy")}
        </Button>
      </span>
    </div>
  );
}
