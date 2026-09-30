import { Tokens } from '@durable-dav/backend-services/composition';
import { BaseRoute } from '@/endpoints/IBaseRoute';
import type { ApiApp, ApiContext } from '@/types/ApiContext';
import { VolumeScopedRoute } from './VolumeScopedRoute';
import type { VolumeRequestContext } from './VolumeScopedRoute';

type App = ApiApp;

class ListCredentials extends VolumeScopedRoute {
  protected async run(c: ApiContext, { scope, row }: VolumeRequestContext): Promise<Response> {
    const credentials = await scope.get(Tokens.VolumeCredentialService).listCredentials(row.id);
    return c.json({
      credentials: credentials.map((cred) => ({
        credentialId: cred.credentialId,
        name: cred.name,
        username: cred.username,
        passwordPrefix: cred.passwordPrefix,
        passwordLastFour: cred.passwordLastFour,
        createdAt: cred.createdAt,
        expiresAt: cred.expiresAt,
        lastUsedAt: cred.lastUsedAt,
        readOnly: cred.readOnly,
      })),
    });
  }
}

class CreateCredential extends VolumeScopedRoute {
  protected async run(c: ApiContext, { scope, row }: VolumeRequestContext): Promise<Response> {
    // Routed through `BaseRoute.readJson` so malformed JSON and an oversize
    // body are distinguished, and so the body is size-capped like every other
    // JSON endpoint.
    const read = await BaseRoute.readJson<{ name?: string; expiresInDays?: unknown; readOnly?: unknown }>(c);
    const unreadable = BaseRoute.rejectUnreadableBody(c, read);
    if (unreadable) return unreadable;
    const { body } = read;
    if (!body.name) return BaseRoute.jsonError(c, 'name is required', 400);
    const created = await scope
      .get(Tokens.VolumeCredentialService)
      .createCredential(row.id, row.name, body.name, body.expiresInDays, body.readOnly);
    return c.json(
      {
        credentialId: created.metadata.credentialId,
        username: created.metadata.username,
        // Shown exactly once — the client is expected to copy it now.
        password: created.password,
        name: created.metadata.name,
        expiresAt: created.metadata.expiresAt,
        passwordPrefix: created.metadata.passwordPrefix,
        passwordLastFour: created.metadata.passwordLastFour,
        // Echoed so the caller sees the flag that was actually applied — a
        // rejected value is a 400, but a default they did not send is not.
        readOnly: created.metadata.readOnly,
      },
      201,
    );
  }
}

/**
 * Flip a credential between read-only and full access.
 *
 * Exists because a read-only credential is otherwise permanent: the flag is
 * chosen at creation, and a client that is handed one cannot undo it. Both
 * directions are equally valid — promoting a read-only mount to full access
 * after the owner has decided the agent is trusted is the common case.
 */
class UpdateCredential extends VolumeScopedRoute {
  protected async run(c: ApiContext, { scope, row }: VolumeRequestContext): Promise<Response> {
    const read = await BaseRoute.readJson<{ readOnly?: unknown }>(c);
    const unreadable = BaseRoute.rejectUnreadableBody(c, read);
    if (unreadable) return unreadable;
    const { body } = read;
    // A non-boolean is a 400 and never a silent `false`: quietly defaulting
    // `"true"` to full access is the one outcome that must not happen by
    // accident.
    if (typeof body.readOnly !== 'boolean') return BaseRoute.jsonError(c, 'readOnly must be a boolean', 400);
    const updated = await scope
      .get(Tokens.VolumeCredentialService)
      .setCredentialReadOnly(row.id, c.req.param('id') ?? '', body.readOnly);
    return c.json({
      credentialId: updated.credentialId,
      username: updated.username,
      name: updated.name,
      expiresAt: updated.expiresAt,
      readOnly: updated.readOnly,
    });
  }
}

class DeleteCredential extends VolumeScopedRoute {
  protected async run(c: ApiContext, { scope, row }: VolumeRequestContext): Promise<Response> {
    await scope.get(Tokens.VolumeCredentialService).deleteCredential(row.id, c.req.param('id') ?? '');
    return c.json({ ok: true });
  }
}

function registerCredentialRoutes(app: App): void {
  const base = '/user/volumes/:owner/:volume/credentials';
  const list = new ListCredentials();
  const create = new CreateCredential();
  const update = new UpdateCredential();
  const remove = new DeleteCredential();
  app.get(base, (c) => list.handle(c));
  app.post(base, (c) => create.handle(c));
  app.patch(`${base}/:id`, (c) => update.handle(c));
  app.delete(`${base}/:id`, (c) => remove.handle(c));
}

export { registerCredentialRoutes };
