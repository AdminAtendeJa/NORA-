-- Cron de los flujos (migraciones 0009 y 0011 ya aplicadas en el proyecto de Nora). Estado final.
-- Despierta cada minuto los flujos que están en un paso "Esperar". Solo llama a flow-engine si hay algo vencido.
-- Requiere un secreto en el Vault llamado 'service_role_key' con la Secret key NUEVA (empieza por sb_secret_).
-- Se crea desde el SQL Editor, sin pegar la clave en ningún chat:
--   select vault.create_secret('sb_secret_...', 'service_role_key');
-- (Si ya existe, actualizarlo con: select vault.update_secret('<id>'::uuid, 'sb_secret_...');)
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.flujos_tick() returns void
language plpgsql security definer set search_path = public, extensions, vault as $$
declare k text;
begin
  if not exists (select 1 from public.flujo_ejecuciones where status = 'activa' and siguiente_ejecucion <= now()) then return; end if;
  select decrypted_secret into k from vault.decrypted_secrets where name = 'service_role_key' limit 1;
  if k is null then return; end if;
  perform net.http_post(
    url := 'https://xjqxabmnkyzifehmvnew.supabase.co/functions/v1/flow-engine',
    headers := jsonb_build_object('Authorization', 'Bearer ' || k, 'Content-Type', 'application/json'),
    body := '{"tick": true}'::jsonb,
    timeout_milliseconds := 20000);
end $$;
revoke all on function public.flujos_tick() from public, anon, authenticated;

select cron.schedule('flujos-tick', '* * * * *', 'select public.flujos_tick()');
select cron.schedule('limpieza-diaria', '17 4 * * *', 'select public.limpiar_datos_antiguos()');
