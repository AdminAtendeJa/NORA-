-- Migración 0012 (ya aplicada en el proyecto de Nora): los flujos pasan de lista de pasos a grafo de nodos y conexiones.
-- Definición: { "version": 2, "nodos": [...], "aristas": [...] }. La tabla estaba vacía, no hubo datos que convertir.
alter table public.flujos drop constraint flujos_definicion_check;
alter table public.flujos add constraint flujos_definicion_check check (
  jsonb_typeof(definicion -> 'nodos') = 'array' and jsonb_typeof(definicion -> 'aristas') = 'array'
  and octet_length(definicion::text) < 400000);
alter table public.flujos alter column definicion set default '{"version":2,"nodos":[{"id":"inicio","tipo":"inicio","x":0,"y":0}],"aristas":[]}'::jsonb;

-- Un flujo solo se puede activar si tiene al menos un paso además del inicio.
create or replace function public.tg_flujo_activar() returns trigger language plpgsql set search_path = public as $$
begin
  if new.activo and (select count(*) from jsonb_array_elements(new.definicion -> 'nodos') n where n ->> 'tipo' <> 'inicio') = 0 then
    raise exception 'Un flujo vacío no se puede activar';
  end if;
  return new;
end $$;
