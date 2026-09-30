const mongoose = require("mongoose");

const matchSchema = new mongoose.Schema(
    {
        user1: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        user2: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        status: {
            type: String,
            enum: ["connected", "ended"],
            default: "connected"
        }
    },
    {
        timestamps: true
    }
);

matchSchema.index({ user1: 1, user2: 1 });
matchSchema.index({ status: 1 });

const Match = mongoose.model("Match", matchSchema);

module.exports = Match;
module.exports.default = Match;