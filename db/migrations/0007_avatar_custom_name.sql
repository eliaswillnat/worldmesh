-- Avatar Wallet: a name the user gives a saved character in "My characters".
-- Kept apart from display_name, which is refreshed from the platform whenever
-- the avatar is saved or worn again. Null means "use the platform's name".

alter table avatar add column custom_name text;
