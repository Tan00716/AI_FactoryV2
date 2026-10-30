/**
 * Webhook endpoints panel (R7-#5) — operator management for the signed
 * receiver: create/list/toggle/delete event -> chain mappings, and the
 * delivery history ring.
 *
 * What this panel never shows: the HMAC secret. It lives in the server
 * environment (FACTORY_WEBHOOK_SECRET), never in webhooks.json, never
 * in a list response, never in this UI. The signing help below
 * describes the scheme so an operator can configure a sender without
 * ever seeing the secret value.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n';

interface Endpoint {
  id: string;
  name: string;
  eventType: string;
  chainLabel: string;
  root: string;
  projectId: string;
  enabled: boolean;
  createdAt: number;
}

interface Delivery {
  id: string;
  endpointId: string | null;
  eventType: string;
  eventId: string;
  receivedAt: number;
  status: string;
  reason?: string;
  chainOk?: boolean;
  chainError?: string;
}

export function WebhooksPanel({ projectRoot }: { projectRoot: string }) {
  const { t } = useLang();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [secretConfigured, setSecretConfigured] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [eventType, setEventType] = useState('push');
  const [chainLabel, setChainLabel] = useState('');
  const [root, setRoot] = useState(projectRoot);
  const [projectId, setProjectId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [eps, dels] = await Promise.all([api.webhookEndpoints(), api.webhookDeliveries()]);
      setEndpoints(eps.endpoints);
      setSecretConfigured(eps.secretConfigured);
      setDeliveries(dels.deliveries);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = useCallback(async () => {
    setError(null);
    setStatus('');
    try {
      await api.webhookCreate({
        id: id.trim(),
        name: name.trim(),
        eventType: eventType.trim(),
        chainLabel: chainLabel.trim(),
        root: root.trim() || projectRoot,
        projectId: projectId.trim(),
      });
      setStatus(t('webhook.created'));
      setId('');
      setName('');
      setChainLabel('');
      setProjectId('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id, name, eventType, chainLabel, root, projectId, projectRoot, load, t]);

  const toggle = useCallback(async (ep: Endpoint) => {
    setError(null);
    try {
      await api.webhookUpdate(ep.id, {
        name: ep.name,
        eventType: ep.eventType,
        chainLabel: ep.chainLabel,
        root: ep.root,
        projectId: ep.projectId,
        enabled: !ep.enabled,
      });
      setStatus(t('webhook.updated'));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [load, t]);

  const remove = useCallback(async (epId: string) => {
    setError(null);
    try {
      await api.webhookDelete(epId);
      setStatus(t('webhook.deleted'));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [load, t]);

  return (
    <div>
      <h2>{t('webhook.title')}</h2>
      <p>{t('webhook.subtitle')}</p>
      <p>
        {secretConfigured ? t('webhook.secretConfigured') : t('webhook.secretMissing')}
      </p>
      <p>{t('webhook.honest')}</p>
      <p>{t('webhook.signingHelp')}</p>
      <button onClick={load} disabled={loading}>{t('webhook.refresh')}</button>
      {error && <p role="alert">{error}</p>}
      {status && <p>{status}</p>}

      <h3>{t('webhook.newEndpoint')}</h3>
      <div>
        <label>{t('webhook.id')}<input value={id} onChange={(e) => setId(e.target.value)} placeholder="gh-push" /></label>
        <label>{t('webhook.name')}<input value={name} onChange={(e) => setName(e.target.value)} placeholder="GitHub push" /></label>
        <label>{t('webhook.eventType')}<input value={eventType} onChange={(e) => setEventType(e.target.value)} /></label>
        <label>{t('webhook.chainLabel')}<input value={chainLabel} onChange={(e) => setChainLabel(e.target.value)} placeholder="lint-and-test" /></label>
        <label>{t('webhook.root')}<input value={root} onChange={(e) => setRoot(e.target.value)} /></label>
        <label>{t('webhook.projectId')}<input value={projectId} onChange={(e) => setProjectId(e.target.value)} /></label>
        <button onClick={create} disabled={!id.trim() || !name.trim() || !eventType.trim() || !chainLabel.trim() || !projectId.trim()}>
          {t('webhook.create')}
        </button>
      </div>

      <h3>{t('webhook.endpoints')}</h3>
      {endpoints.length === 0 ? (
        <p>{t('webhook.noEndpoints')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('webhook.id')}</th>
              <th>{t('webhook.name')}</th>
              <th>{t('webhook.eventType')}</th>
              <th>{t('webhook.chainLabel')}</th>
              <th>{t('webhook.enabled')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((ep) => (
              <tr key={ep.id}>
                <td>{ep.id}</td>
                <td>{ep.name}</td>
                <td>{ep.eventType}</td>
                <td>{ep.chainLabel}</td>
                <td>{ep.enabled ? t('webhook.yes') : t('webhook.no')}</td>
                <td>
                  <button onClick={() => toggle(ep)}>{t('webhook.toggle')}</button>
                  <button onClick={() => remove(ep.id)}>{t('webhook.delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>{t('webhook.deliveries')}</h3>
      {deliveries.length === 0 ? (
        <p>{t('webhook.noDeliveries')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('webhook.eventType')}</th>
              <th>{t('webhook.eventId')}</th>
              <th>{t('webhook.status')}</th>
              <th>{t('webhook.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.id}>
                <td>{d.eventType}</td>
                <td>{d.eventId.slice(0, 24)}</td>
                <td>{d.status}{d.chainOk === false && d.chainError ? ` (${d.chainError})` : ''}</td>
                <td>{d.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
