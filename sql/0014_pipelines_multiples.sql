-- Varios pipelines por negocio, cada uno con sus etapas. El cliente crea todo desde el panel.
create table if not exists public.pipelines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nombre text not null check (char_length(nombre) between 1 and 40),
  orden int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists pipelines_org on public.pipelines (organization_id, orden);
alter table public.pipelines enable row level security;
create policy pipelines_select on public.pipelines for select using (is_member(organization_id));
create policy pipelines_insert on public.pipelines for insert with check (tiene_rol(organization_id, array['dueno','admin']));
create policy pipelines_update on public.pipelines for update using (tiene_rol(organization_id, array['dueno','admin'])) with check (tiene_rol(organization_id, array['dueno','admin']));
create policy pipelines_delete on public.pipelines for delete using (tiene_rol(organization_id, array['dueno','admin']));

alter table public.pipeline_etapas add column if not exists pipeline_id uuid references public.pipelines(id) on delete cascade;
alter table public.contacts add column if not exists pipeline_id uuid references public.pipelines(id) on delete set null;

-- Pipeline inicial "Ventas" por negocio con las etapas ya sembradas
insert into public.pipelines (organization_id, nombre, orden)
select o.id, 'Ventas', 0 from public.organizations o
where not exists (select 1 from public.pipelines p where p.organization_id = o.id);
update public.pipeline_etapas e set pipeline_id = (select p.id from public.pipelines p where p.organization_id = e.organization_id order by p.orden limit 1) where e.pipeline_id is null;
update public.contacts c set pipeline_id = (select p.id from public.pipelines p where p.organization_id = c.organization_id order by p.orden limit 1) where c.pipeline_id is null;
alter table public.pipeline_etapas alter column pipeline_id set not null;
alter table public.pipeline_etapas drop constraint if exists pipeline_etapas_organization_id_clave_key;
alter table public.pipeline_etapas add constraint pipeline_etapas_pipeline_clave_key unique (pipeline_id, clave);
create index if not exists pipeline_etapas_pipeline on public.pipeline_etapas (pipeline_id, orden);

-- Negocio nuevo: un pipeline "Ventas" con 4 etapas que el dueño puede cambiar o borrar
create or replace function public.sembrar_pipeline(org uuid) returns void
language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  if exists (select 1 from pipelines where organization_id = org) then return; end if;
  insert into pipelines (organization_id, nombre, orden) values (org, 'Ventas', 0) returning id into pid;
  insert into pipeline_etapas (organization_id, pipeline_id, clave, nombre, color, orden, tipo) values
    (org, pid, 'nuevo',      'Nuevo',      '#3b82f6', 0, 'normal'),
    (org, pid, 'interesado', 'Interesado', '#f59e0b', 1, 'normal'),
    (org, pid, 'cliente',    'Cliente',    '#10b981', 2, 'ganado'),
    (org, pid, 'perdido',    'Perdido',    '#ef4444', 3, 'perdido');
end $$;
revoke all on function public.sembrar_pipeline(uuid) from public, anon, authenticated;

-- Contacto nuevo: entra al primer pipeline, en su primera etapa
create or replace function public.trg_contacto_pipeline() returns trigger
language plpgsql security definer set search_path = public as $$
declare pid uuid; clave text;
begin
  if new.pipeline_id is null then
    select id into pid from pipelines where organization_id = new.organization_id order by orden, created_at limit 1;
    if pid is not null then
      select e.clave into clave from pipeline_etapas e where e.pipeline_id = pid order by e.orden, e.created_at limit 1;
      new.pipeline_id := pid;
      if clave is not null then new.etapa := clave; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists contacts_pipeline on public.contacts;
create trigger contacts_pipeline before insert on public.contacts for each row execute function public.trg_contacto_pipeline();

drop function if exists public.eliminar_etapa(uuid, text);
create or replace function public.eliminar_etapa(p_etapa uuid, p_destino text) returns void
language plpgsql security invoker set search_path = public as $$
declare e pipeline_etapas;
begin
  select * into e from pipeline_etapas where id = p_etapa;
  if not found then raise exception 'La etapa no existe'; end if;
  if e.clave = p_destino then raise exception 'Elige otra etapa de destino'; end if;
  if not exists (select 1 from pipeline_etapas where pipeline_id = e.pipeline_id and clave = p_destino) then
    raise exception 'La etapa de destino no existe en este pipeline';
  end if;
  update contacts set etapa = p_destino where pipeline_id = e.pipeline_id and etapa = e.clave;
  delete from pipeline_etapas where id = p_etapa;
end $$;
grant execute on function public.eliminar_etapa(uuid, text) to authenticated;

-- Borrar un pipeline pasando sus contactos a la primera etapa de otro
create or replace function public.eliminar_pipeline(p_pipeline uuid, p_destino uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare org uuid; clave text;
begin
  select organization_id into org from pipelines where id = p_pipeline;
  if org is null then raise exception 'El pipeline no existe'; end if;
  if p_pipeline = p_destino then raise exception 'Elige otro pipeline de destino'; end if;
  if not exists (select 1 from pipelines where id = p_destino and organization_id = org) then raise exception 'El pipeline de destino no existe'; end if;
  select e.clave into clave from pipeline_etapas e where e.pipeline_id = p_destino order by e.orden, e.created_at limit 1;
  if clave is null then raise exception 'El pipeline de destino no tiene etapas'; end if;
  update contacts set pipeline_id = p_destino, etapa = clave where pipeline_id = p_pipeline;
  delete from pipelines where id = p_pipeline;
end $$;
grant execute on function public.eliminar_pipeline(uuid, uuid) to authenticated;
