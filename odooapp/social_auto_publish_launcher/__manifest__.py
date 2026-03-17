{
    "name": "Social Auto Publish Launcher",
    "version": "19.0.1.1.0",
    "category": "Marketing/Social Marketing",
    "summary": "Standalone launcher app for external one-click publishing",
    "description": "Standalone Odoo 19 app that opens the external one-click publish frontend.",
    "author": "OpenAI",
    "license": "LGPL-3",
    "depends": ["base", "web"],
    "data": [
        "security/ir.model.access.csv",
        "views/launcher_client_action.xml",
        "views/launcher_menus.xml"
    ],
    "assets": {
        "web.assets_backend": [
            "social_auto_publish_launcher/static/src/scss/launcher_app.scss",
            "social_auto_publish_launcher/static/src/js/launcher_app.js",
            "social_auto_publish_launcher/static/src/xml/launcher_app.xml"
        ]
    },
    "installable": True,
    "application": True,
    "auto_install": False,
}
