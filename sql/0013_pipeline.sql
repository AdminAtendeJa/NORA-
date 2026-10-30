-- Pipeline (embudo) estilo Kommo: etapas configurables por negocio. El contacto es la "tarjeta".
create table if not exists public.pipeline_etapas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  clave text not null,
  nombre text not null check (char_length(nombre) between 1 and 40),
  color text not null default '#64748b',
  orden int not null default 0,
  tipo text not null default 'normal' check (tipo in ('normal','ganado','perdido')),
  created_at timestamptz not null default now(),
  unique (organization_id, clave)
);
create index if not exists pipeline_etapas_org on public.pipeline_etapas (organization_id, orden);

alter table public.pipeline_etapas enable row level security;
create policy pipeline_etapas_select on public.pipeline_etapas for select using (is_member(organization_id));
create policy pipeline_etapas_insert on public.pipeline_etapas for insert with check (tiene_rol(organization_id, array['dueno','admin']));
create policy pipeline_etapas_update on public.pipeline_etapas for update using (tiene_rol(organization_id, array['dueno','admin'])) with check (tiene_rol(organization_id, array['dueno','admin']));
create policy pipeline_etapas_delete on public.pipeline_etapas for delete using (tiene_rol(organization_id, array['dueno','admin']));

-- Etapas iniciales de cada negocio (las mismas cuatro que ya existían)
create or replace function public.sembrar_pipeline(org uuid) returns void
language sql security definer set search_path = public as $$
  insert into pipeline_etapas (organization_id, clave, nombre, color, orden, tipo) values
    (org, 'nuevo',      'Nuevo',      '#3b82f6', 0, 'normal'),
    (org, 'interesado', 'Interesado', '#f59e0b', 1, 'normal'),
    (org, 'cliente',    'Cliente',    '#10b981', 2, 'ganado'),
    (org, 'perdido',    'Perdido',    '#ef4444', 3, 'perdido')
  on conflict (organization_id, clave) do nothing;
$$;
revoke all on function public.sembrar_pipeline(uuid) from public, anon, authenticated;

create or replace function public.trg_sembrar_pipeline() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform sembrar_pipeline(new.id); return new; end $$;
drop trigger if exists organizations_pipeline on public.organizations;
create trigger organizations_pipeline after insert on public.organizations
  for each row execute function public.trg_sembrar_pipeline();

select public.sembrar_pipeline(id) from public.organizations;

-- El contacto ya no está limitado a 4 etapas fijas; además tiene valor del negocio y desde cuándo está en la etapa
alter table public.contacts drop constraint if exists contacts_etapa_check;
alter table public.contacts add column if not exists valor numeric(12,2) not null default 0 check (valor >= 0);
alter table public.contacts add column if not exists etapa_desde timestamptz not null default now();

create or replace function public.trg_etapa_desde() returns trigger
language plpgsql as $$
begin
  if new.etapa is distinct from old.etapa then new.etapa_desde := now(); end if;
  return new;
end $$;
drop trigger if exists contacts_etapa_desde on public.contacts;
create trigger contacts_etapa_desde before update on public.contacts
  for each row execute function public.trg_etapa_desde();

-- Borrar una etapa moviendo antes sus contactos a otra (con los permisos de quien llama)
create or replace function public.eliminar_etapa(p_etapa uuid, p_destino text) returns void
language plpgsql security invoker set search_path = public as $$
declare e pipeline_etapas;
begin
  select * into e from pipeline_etapas where id = p_etapa;
  if not found then raise exception 'La etapa no existe'; end if;
  if e.clave = p_destino then raise exception 'Elige otra etapa de destino'; end if;
  if not exists (select 1 from pipeline_etapas where organization_id = e.organization_id and clave = p_destino) then
    raise exception 'La etapa de destino no existe';
  end if;
  update contacts set etapa = p_destino where organization_id = e.organization_id and etapa = e.clave;
  delete from pipeline_etapas where id = p_etapa;
end $$;
grant execute on function public.eliminar_etapa(uuid, text) to authenticated;
