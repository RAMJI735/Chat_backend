const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
    {
        username: {
            type: String,
            required: [true, "Username is required"],
            unique: true,
            trim: true,
            minlength: [3, "Username must be at least 3 characters long"],
            maxlength: [30, "Username cannot exceed 30 characters"]
        },
        email: {
            type: String,
            trim: true,
            lowercase: true,
            sparse: true,
            match: [/^\S+@\S+\.\S+$/, "Please provide a valid email address"]
        },
        password: {
            type: String,
            minlength: [6, "Password must be at least 6 characters long"],
            select: false
        },
        fullName: {
            type: String,
            trim: true,
            default: ""
        },
        avatar: {
            type: String,
            default: function () {
                return `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(this.username || "user")}`;
            }
        },
        bio: {
            type: String,
            default: "Hey there! I am using SocketChat.",
            maxlength: [150, "Bio cannot exceed 150 characters"]
        },
        country: {
            type: String,
            trim: true,
            default: ""
        },
        socketId: {
            type: String,
            default: null
        },
        isOnline: {
            type: Boolean,
            default: false
        },
        lastSeen: {
            type: Date,
            default: Date.now
        }
    },
    {
        timestamps: true
    }
);

// Hash password before saving in Mongoose (async hook returns Promise)
userSchema.pre("save", async function () {
    if (!this.isModified("password") || !this.password) {
        return;
    }
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
    if (!this.password) return false;
    return bcrypt.compare(candidatePassword, this.password);
};

// Helpful index for fast online user lookups
userSchema.index({ isOnline: 1 });

module.exports = mongoose.model("User", userSchema);
