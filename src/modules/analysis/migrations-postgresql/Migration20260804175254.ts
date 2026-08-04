import { Migration } from '@mikro-orm/migrations';

export class Migration20260804175254 extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "analysis_record" ("id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "retention_anonymized_at" timestamptz null, "message" text not null, primary key ("id"));`);

    this.addSql(`create table "startup_idea" ("id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "retention_anonymized_at" timestamptz null, "title" text not null, "pitch" text not null, "organization_id" text not null, primary key ("id"));`);
    this.addSql(`create index "startup_idea_organization_id_index" on "startup_idea" ("organization_id");`);

    this.addSql(`create table "gtm_report" ("id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "retention_anonymized_at" timestamptz null, "idea_id" uuid not null, "version" int not null, "pitch_snapshot" text not null, "viability_score" int not null, "verdict" text not null, "summary" text not null, "dimensions" jsonb not null, "signals" jsonb not null, "bear_case" jsonb not null, "blueprint" jsonb null, "organization_id" text not null, primary key ("id"));`);
    this.addSql(`create index "gtm_report_organization_id_index" on "gtm_report" ("organization_id");`);

    this.addSql(`alter table "gtm_report" add constraint "gtm_report_idea_id_foreign" foreign key ("idea_id") references "startup_idea" ("id");`);
  }

}
