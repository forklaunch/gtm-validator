import { Migration } from '@mikro-orm/migrations';

export class Migration20260804181719 extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "founder" ("id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "retention_anonymized_at" timestamptz null, "name" text not null, "email" text not null, "email_lookup_hash" text not null, "company" text null, "organization_id" text not null, primary key ("id"));`);
    this.addSql(`create index "founder_email_lookup_hash_index" on "founder" ("email_lookup_hash");`);
    this.addSql(`create index "founder_organization_id_index" on "founder" ("organization_id");`);

    this.addSql(`alter table "startup_idea" add "founder_id" uuid not null;`);
    this.addSql(`alter table "startup_idea" add constraint "startup_idea_founder_id_foreign" foreign key ("founder_id") references "founder" ("id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "startup_idea" drop constraint "startup_idea_founder_id_foreign";`);

    this.addSql(`drop table if exists "founder" cascade;`);

    this.addSql(`alter table "startup_idea" drop column "founder_id";`);
  }

}
