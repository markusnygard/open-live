terraform {
  required_version = ">= 1.6.0"
  required_providers {
    osc = {
      source  = "registry.terraform.io/EyevinnOSC/osc"
      version = "0.3.0"
    }
  }
}

############################
# Variables (inputs)
############################

variable "osc_pat" {
  type        = string
  sensitive   = true
  description = "Eyevinn OSC Personal Access Token"
}

variable "osc_environment" {
  type        = string
  default     = "prod"
  description = "OSC Environment"
}

variable "open_live_name" {
  type        = string
  default     = "myopenlive"
  description = "Name of the Open Live instance. Lower case letters and numbers only."
}

variable "db_admin_password" {
  type        = string
  default     = null
  sensitive   = true
  description = "CouchDB admin password. Leave empty to auto-generate."
}

variable "strom_url" {
  type        = string
  description = "URL of the Strom media pipeline instance"
}

variable "strom_access_token" {
  type        = string
  sensitive   = true
  description = "Access token for the Strom media pipeline instance"
}

############################
# Locals
############################

locals {
  db_admin_password_final = var.db_admin_password != null ? var.db_admin_password : random_password.db_admin_password.result
  db_host                 = trimprefix(osc_apache_couchdb.this.instance_url, "https://")
}

############################
# Provider
############################

provider "osc" {
  pat         = var.osc_pat
  environment = var.osc_environment
}

############################
# Random passwords
############################

resource "random_password" "db_admin_password" {
  length  = 16
  special = false
}

############################
# Secrets
############################

resource "osc_secret" "dburl" {
  service_ids  = ["eyevinn-open-live"]
  secret_name  = "${var.open_live_name}dburl"
  secret_value = "https://admin:${local.db_admin_password_final}@${local.db_host}"
}

resource "osc_secret" "strom_token" {
  service_ids  = ["eyevinn-open-live"]
  secret_name  = "${var.open_live_name}stromtoken"
  secret_value = var.strom_access_token
}

resource "osc_secret" "oscpat" {
  service_ids  = ["eyevinn-open-live-studio"]
  secret_name  = "${var.open_live_name}oscpat"
  secret_value = var.osc_pat
}

############################
# CouchDB
############################

resource "osc_apache_couchdb" "this" {
  name           = "${var.open_live_name}db"
  admin_password = format("{{secrets.%s}}", osc_secret.dburl.secret_name)
}

############################
# Open Live
############################

resource "osc_eyevinn_open_live" "this" {
  name         = var.open_live_name
  database_url = format("{{secrets.%s}}", osc_secret.dburl.secret_name)
  strom_url    = var.strom_url
  strom_access_token = format("{{secrets.%s}}", osc_secret.strom_token.secret_name)

  depends_on = [osc_apache_couchdb.this]
}

############################
# Open Live Studio
############################

resource "osc_eyevinn_open_live_studio" "this" {
  name           = "${var.open_live_name}studio"
  open_live_url  = osc_eyevinn_open_live.this.instance_url
  osc_access_token = format("{{secrets.%s}}", osc_secret.oscpat.secret_name)

  depends_on = [osc_eyevinn_open_live.this]
}

############################
# Outputs
############################

output "OpenLive_instance_url" {
  value = osc_eyevinn_open_live.this.instance_url
}

output "Studio_instance_url" {
  value = osc_eyevinn_open_live_studio.this.instance_url
}

output "Database_instance_url" {
  value = osc_apache_couchdb.this.instance_url
}
