-- Flujos de automatización (estilo Salesbot de Kommo): el dueño define qué pasa desde que entra un cliente.
-- Aplicar en el proyecto de Nora (xjqxabmnkyzifehmvnew), después de las migraciones 0002–0007.

-- ===== Flujos =====
create table public.flujos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nombre text not null check (length(trim(nombre)) between 1 and 80),
  activo boolean not null default false,
  -- {"tipo":"conversacion_nueva"} | {"tipo":"palabra_clave","palabras":["precio","info"]}
  disparador jsonb not null default '{"tipo":"conversacion_nueva"}',
  definicion jsonb not null default '{"pasos":[]}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint flujos_disparador_check check (disparador ->> 'tipo' in ('conversacion_nueva', 'palabra_clave')),
  constraint flujos_definicion_check check (jsonb_typeof(definicion -> 'pasos') = 'array' and octet_length(definicion::text) < 200000)
);
create index flujos_org_idx on public.flujos (organization_id, activo);
alter table public.flujos enable row level security;
create policy flujos_select on public.flujos for select to authenticated using (public.is_member(organization_id));
create policy flujos_insert on public.flujos for insert to authenticated with check (public.tiene_rol(organization_id, array['dueno','admin']));
create policy flujos_update on public.flujos for update to authenticated using (public.tiene_rol(organization_id, array['dueno','admin'])) with check (public.tiene_rol(organization_id, array['dueno','admin']));
create policy flujos_delete on public.flujos for delete to authenticated using (public.tiene_rol(organization_id, array['dueno','admin']));
create trigger flujos_updated before update on public.flujos for each row execute function public.tg_set_updated_at();
create trigger audit_flujos after insert or update or delete on public.flujos for each row execute function public.tg_auditar();

-- ===== Ejecuciones: una por conversación (la definición se congela al empezar, así editar el flujo no rompe chats en curso) =====
create table public.flujo_ejecuciones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flujo_id uuid references public.flujos(id) on delete set null,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  definicion jsonb not null,
  estado jsonb not null,                                  -- {pc, datos, esperando, fin} (ver motor.ts)
  status text not null default 'activa' check (status in ('activa','completada','cancelada','error')),
  siguiente_ejecucion timestamptz,                        -- cuando el flujo está en un paso "esperar"
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index flujo_ejecuciones_activa_idx on public.flujo_ejecuciones (conversation_id) where status = 'activa';
create index flujo_ejecuciones_tick_idx on public.flujo_ejecuciones (siguiente_ejecucion) where status = 'activa' and siguiente_ejecucion is not null;
create index flujo_ejecuciones_org_idx on public.flujo_ejecuciones (organization_id, created_at desc);
create index flujo_ejecuciones_flujo_idx on public.flujo_ejecuciones (flujo_id);
create index flujo_ejecuciones_contact_idx on public.flujo_ejecuciones (contact_id);
alter table public.flujo_ejecuciones enable row level security;
create policy flujo_ejecuciones_select on public.flujo_ejecuciones for select to authenticated using (public.is_member(organization_id));
create trigger flujo_ejecuciones_updated before update on public.flujo_ejecuciones for each row execute function public.tg_set_updated_at();

-- ===== Datos que el flujo guarda del contacto (ya existe contacts.datos jsonb) =====
-- Mezcla un dato sin pisar los demás (evita leer-y-escribir desde el servidor).
create or replace function public.contacto_guardar_dato(p_contact uuid, p_campo text, p_valor text) returns void
language sql security definer set search_path = public as $$
  update public.contacts set datos = coalesce(datos, '{}'::jsonb) || jsonb_build_object(p_campo, p_valor) where id = p_contact;
$$;
create or replace function public.contacto_agregar_etiqueta(p_contact uuid, p_etiqueta text) returns void
language sql security definer set search_path = public as $$
  update public.contacts set tags = (select array(select distinct unnest(coalesce(tags, '{}') || array[left(trim(p_etiqueta), 40)]))) where id = p_contact;
$$;
revoke all on function public.contacto_guardar_dato(uuid, text, text), public.contacto_agregar_etiqueta(uuid, text) from public, anon, authenticated;
grant execute on function public.contacto_guardar_dato(uuid, text, text), public.contacto_agregar_etiqueta(uuid, text) to service_role;

-- ===== Un flujo no puede activarse sin pasos =====
create or replace function public.tg_flujo_activar() returns trigger language plpgsql set search_path = public as $$
begin
  if new.activo and jsonb_array_length(new.definicion -> 'pasos') = 0 then
    raise exception 'Un flujo vacío no se puede activar';
  end if;
  return new;
end $$;
create trigger flujos_activar before insert or update on public.flujos for each row execute function public.tg_flujo_activar();

-- ===== Limpieza de ejecuciones antiguas (se suma a limpiar_datos_antiguos) =====
create or replace function public.limpiar_datos_antiguos() returns void language sql security definer set search_path = public as $$
  delete from public.webhook_events where recibido_at < now() - interval '30 days';
  delete from public.invitations where (accepted_at is not null or expires_at < now() - interval '30 days') and created_at < now() - interval '30 days';
  delete from public.flujo_ejecuciones where status <> 'activa' and updated_at < now() - interval '90 days';
$$;
