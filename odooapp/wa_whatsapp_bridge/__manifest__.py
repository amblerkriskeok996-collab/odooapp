{
    "name": "WhatsApp Auto Reply Bridge",
    "summary": "Manage WhatsApp auto-reply runtime from Odoo",
    "version": "19.0.1.0.0",
    "category": "Tools",
    "author": "Local Integration",
    "license": "LGPL-3",
    "depends": ["base", "web"],
    "data": [
        "security/ir.model.access.csv",
        "data/wa_service_data.xml",
        "views/wa_service_views.xml",
        "views/menus.xml"
    ],
    "assets": {
        "web.assets_backend": [
            "wa_whatsapp_bridge/static/src/scss/wa_chat_workspace.scss",
            "wa_whatsapp_bridge/static/src/js/wa_chat_workspace.js",
            "wa_whatsapp_bridge/static/src/xml/wa_chat_workspace.xml",
            "wa_whatsapp_bridge/static/src/scss/wa_portal_action.scss",
            "wa_whatsapp_bridge/static/src/js/wa_portal_action.js",
            "wa_whatsapp_bridge/static/src/xml/wa_portal_action.xml"
        ]
    },
    "application": True,
    "installable": True,
}
